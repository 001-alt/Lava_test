/* ============================================================================
   SSH 巡检通道（页面侧）
   ----------------------------------------------------------------------------
   桥接负责真的去 SSH；这里负责把巡检结果落到看板上：

     · 设备在线/离线/在测状态   → App.eqRuntime，平面图据此显示
     · SSH 异常 / 测试异常      → 报错记录（同机台同类型同日合并计数）
     · 数据新鲜度               → 巡检失败时沿用上轮结果并明确标注为「旧数据」

   沿用 RDIMM 的经验：**不把旧数据当实时状态展示**。
   巡检失败时保留上次结果，但打上 stale 标记，界面上要能看出来。
   ============================================================================ */

const Ssh = (() => {

  let _busy = false;
  let _lastSnapAt = 0;
  let _lastError = '';

  /* --------------------------------------------------------------------------
     巡检
     -------------------------------------------------------------------------- */
  async function poll(silent) {
    if (_busy) return null;
    if (!Bridge.configured()) return null;
    _busy = true;
    try {
      const snap = await Bridge.api('/api/ssh/status', null, { timeout: 30000 });
      if (snap && snap.hosts) {
        applySnapshot(snap, silent);
        _lastSnapAt = snap.at || Date.now();
        _lastError = '';
        return snap;
      }
      return null;
    } catch (e) {
      _lastError = e.message;
      if (!silent) console.warn('[Ssh] 巡检失败：', e.message);
      return null;
    } finally {
      _busy = false;
    }
  }

  /* 立即触发一次（页面上的「巡检」按钮 / 下发清单后） */
  async function probeNow(silent) {
    if (!Bridge.configured()) return null;
    try {
      const snap = await Bridge.api('/api/ssh/probe', null, { timeout: 120000 });
      if (snap && snap.hosts) {
        applySnapshot(snap, silent);
        _lastSnapAt = snap.at || Date.now();
        return snap;
      }
    } catch (e) {
      _lastError = e.message;
      if (!silent) Toast.error('巡检失败：' + e.message);
    }
    return null;
  }

  /* --------------------------------------------------------------------------
     应用快照
     -------------------------------------------------------------------------- */
  function applySnapshot(snap, silent) {
    const hosts = snap.hosts || [];
    const idx = ipIndex();
    const rt = App.state.eqRuntime || (App.state.eqRuntime = {});
    const now = Date.now();
    let matched = 0, unmatched = 0;
    const alarms = [];

    hosts.forEach(h => {
      const eq = idx[h.ip];
      if (!eq) { unmatched++; return; }
      matched++;
      const prev = rt[eq.id] || {};
      const errorKind = h.errorKind || 'none';
      const hasErr = errorKind && errorKind !== 'none';

      rt[eq.id] = {
        ip: h.ip,
        power: h.power || 'unknown',
        testing: !!h.testing,
        errorKind,
        errorHint: h.errorHint || '',
        errorMsg: h.errorMsg || '',
        hostname: h.hostname || prev.hostname || '',
        latestLog: h.latestLog || '',
        latestLogTime: h.latestLogTime || null,
        logAgeSec: h.logAgeSec == null ? null : h.logAgeSec,
        // 沿用上一轮结果时必须标出来，否则会误以为是实时状态
        stale: !!h.stale,
        staleSec: h.staleSec || 0,
        checkedAt: h.checkedAt || now,
        source: 'ssh'
      };

      if (hasErr) alarms.push({ eq, h, kind: errorKind });
      else if ((h.power === 'on') && (h.latestLogTime === 0 || h.latestLogTime == null)) {
        // 在线但读不到日志目录 —— 可能是路径配错，值得提示一次
      }
    });

    App.state.eqIndexMatched = matched;
    App.state.eqIndexUnmatched = unmatched;
    App.state.lastSshAt = snap.at || now;

    /* 巡检异常 → 报错记录（按 机台+类型+日期 合并计数） */
    recordAlarms(alarms);

    Bus.emit('ssh:applied', snap);
    if (!silent) {
      const s = snap.summary || {};
      Toast.ok('在线 ' + (s.online || 0) + ' · 离线 ' + (s.offline || 0) +
               ' · 在测 ' + (s.testing || 0) +
               (s.sshError ? ' · SSH异常 ' + s.sshError : '') +
               (unmatched ? ' · 未匹配 ' + unmatched : ''),
               '巡检完成（' + (s.elapsedSec || 0) + ' 秒）');
    }
  }

  /* IP → 设备索引。设备台账是唯一权威来源 ——
     没有台账就无从知道 IP 属于哪台设备。 */
  function ipIndex() {
    const idx = {};
    Topology.all(App.cfg).equipment.forEach(eq => {
      if (eq.ip) idx[eq.ip] = eq;
      if (eq.ipAlt) idx[eq.ipAlt] = eq;
    });
    return idx;
  }

  /* --------------------------------------------------------------------------
     巡检异常写入报错记录
     同机台、同类型、同一天只留一条并累加次数 —— 否则每轮巡检都会堆一批
     -------------------------------------------------------------------------- */
  async function recordAlarms(alarms) {
    if (!alarms.length) return 0;
    const day = Util.todayKey();
    const existing = App.error || (App.error = []);
    let added = 0;

    for (const a of alarms) {
      const eq = a.eq, h = a.h;
      const type = 'SSH异常·' + (h.errorHint || h.errorKind || '未知');
      const key = [eq.id, type, day].join('|');
      const dup = existing.filter(e => e.dedupKey === key)[0];

      if (dup) {
        dup.count = (dup.count || 1) + 1;
        dup.lastTime = h.checkedAt || Date.now();
        dup.message = h.errorMsg || h.errorHint || '';
        dup.updatedAt = Date.now();
        await Repo.put('error', dup);
      } else {
        const rec = Schema.newError({
          station: eq.station,
          cabinetId: eq.cabinetId,
          equipmentId: eq.id,
          type,
          message: h.errorMsg || h.errorHint || '',
          sn: '',
          day,
          count: 1,
          source: 'ssh',
          dedupKey: key,
          time: h.checkedAt || Date.now()
        });
        existing.unshift(rec);
        await Repo.put('error', rec);
        added++;
      }
    }
    if (added) Bus.emit(EVT.RECORDS_CHANGED, { store: 'error' });
    return added;
  }

  /* --------------------------------------------------------------------------
     按需读取（在「日志分析」等页面用）
     -------------------------------------------------------------------------- */
  async function ls(ip, dir) {
    const r = await Bridge.api('/api/ssh/ls', { ip, dir });
    return (r && r.entries) || [];
  }
  async function cat(ip, file, max) {
    return Bridge.fetchText('/api/ssh/cat', { ip, file, max: max || 524288 });
  }
  async function slt(ip, root) {
    return Bridge.fetchText('/api/ssh/slt', { ip, root });
  }

  return {
    poll, probeNow, applySnapshot, ipIndex, recordAlarms,
    ls, cat, slt,
    lastAt: () => _lastSnapAt,
    lastError: () => _lastError,
    isBusy: () => _busy
  };
})();
