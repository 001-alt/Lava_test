/* ============================================================================
   备份与恢复
   ----------------------------------------------------------------------------
   RDIMM 的教训：它把「导出完整 JSON」当作唯一的可靠恢复手段，但 12,737 个
   盘位的裸 JSON 有数 MB，JSON.stringify 峰值内存高、单文件下载体验差。

   这里分三种粒度：
     1. 配置备份   只导规则/设置（几十 KB）—— 换电脑最快
     2. 状态快照   拓扑 + 非空盘位（约 1-2 MB）
     3. 全量备份   状态 + 记录表（可能数十 MB，导出前提示体积）
   ============================================================================ */

const Backup = (() => {

  const FORMAT = 'lava-test-backup';
  const FORMAT_VERSION = 1;

  /* 盘位对象压缩为数组。
     首列必须是 key（'station|equipmentId|slotIndex'）—— cabinetId/serverId/boxId
     都能由它经 Topology 推导，而 key 本身是恢复时的唯一定位依据。
     ⚠️ 不能靠「顺序对齐」重建 key：拓扑一改（如 FINAL 设备数变动）就会整体错位。 */
  const SLOT_COLS = ['key', 'state', 'sn', 'pn', 'woNo', 'result', 'errCode',
                     'startTime', 'endTime', 'retestRound', 'source'];

  function packSlots(slots) {
    return (slots || []).map(s => SLOT_COLS.map(c => s[c] == null ? '' : s[c]));
  }
  function unpackSlots(rows) {
    return (rows || []).map(r => {
      const o = {};
      SLOT_COLS.forEach((c, i) => {
        let v = r[i];
        if (v === '') v = null;
        o[c] = v;
      });
      o.state = o.state || 'empty';
      return o;
    });
  }

  /* --------------------------------------------------------------------------
     导出
       scope: 'config' | 'snapshot' | 'full'
     -------------------------------------------------------------------------- */
  async function exportData(scope, cfg, extra) {
    const s = scope || 'snapshot';
    const t0 = Date.now();

    const manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      app: APP_NAME,
      appVersion: APP_VERSION,
      scope: s,
      builtAt: Date.now(),
      builtAtText: Util.nowStr(),
      stationOverride: cfg.stationOverride || {},
      counts: {}
    };

    const out = { manifest };

    /* --- 配置层 --- */
    out.config = {
      stationOverride: cfg.stationOverride,
      defectRules: cfg.defectRules,
      errorCodeRules: cfg.errorCodeRules,
      matchRules: cfg.matchRules,
      pnPresets: cfg.pnPresets,
      fieldMapping: cfg.fieldMapping,
      fieldDefs: cfg.fieldDefs,
      channels: cfg.channels,
      scanRoots: cfg.scanRoots,
      parseRules: cfg.parseRules,
      settings: cfg.settings,
      ui: cfg.ui
    };

    if (s === 'config') {
      manifest.counts = { slots: 0, records: 0 };
      out.slotColumns = SLOT_COLS;
      out.slots = [];
      return finish(out, manifest, t0);
    }

    /* --- 盘位 --- */
    const allSlots = await Repo.getAllSlots();
    const nonEmpty = allSlots.filter(x => x.state && x.state !== 'empty');
    out.slotColumns = SLOT_COLS;
    out.slots = packSlots(nonEmpty);
    manifest.counts.slots = nonEmpty.length;
    manifest.counts.slotCapacity = Topology.all(cfg).totalSlots;

    /* --- 记录表 --- */
    if (s === 'full') {
      out.records    = await Repo.query('records', null, { limit: 200000 });
      out.bad        = await Repo.query('bad', null, { limit: 200000 });
      out.error      = await Repo.query('error', null, { limit: 200000 });
      out.judgements = await Repo.query('judgements', null, { limit: 200000 });
      out.archives   = await Repo.query('archives', null, { limit: 200000 });
      out.logindex   = await Repo.query('logindex', null, { limit: 200000 });
      out.workOrders = (extra && extra.workOrders) || [];
      manifest.counts.records    = out.records.length;
      manifest.counts.bad        = out.bad.length;
      manifest.counts.error      = out.error.length;
      manifest.counts.judgements = out.judgements.length;
      manifest.counts.workOrders = out.workOrders.length;
    } else {
      // 快照也带上工单与未确认不良，否则恢复后看不到待办
      out.workOrders = (extra && extra.workOrders) || [];
      out.bad = (await Repo.query('bad', null, { limit: 200000 })).filter(b => !b.confirmed);
      manifest.counts.workOrders = out.workOrders.length;
      manifest.counts.bad = out.bad.length;
    }

    manifest.elapsedMs = Date.now() - t0;
    return finish(out, manifest, t0);
  }

  function finish(obj, manifest, t0) {
    manifest.elapsedMs = Date.now() - t0;
    const text = JSON.stringify(obj, null, 0);
    return { json: text, manifest, size: text.length };
  }

  /* 文件名 */
  function filename(scope) {
    const tag = { config: '配置', snapshot: '快照', full: '全量' }[scope] || '备份';
    return 'lava_test_' + tag + '_' + Util.tsTag() + '.json';
  }

  /* 一键导出（含体积提示） */
  async function download(scope, cfg, extra) {
    const s = scope || 'snapshot';
    Toast.info('正在打包' + ({ config: '配置', snapshot: '状态快照', full: '全量备份' }[s]) + '…');
    // 让提示先渲染出来再做重活
    await new Promise(r => setTimeout(r, 50));
    try {
      const r = await exportData(s, cfg, extra);
      if (s === 'full' && r.size > 20 * 1024 * 1024) {
        const go = await Modal.confirm({
          title: '备份体积较大',
          html: '全量备份约 <b>' + Util.bytes(r.size) + '</b>，生成与下载可能较慢。<br>确定继续吗？',
          okText: '继续导出'
        });
        if (!go) return null;
      }
      Util.download(filename(s), r.json, 'application/json;charset=utf-8');
      Toast.ok('已导出 ' + Util.bytes(r.size) +
               '（盘位 ' + Util.num(r.manifest.counts.slots || 0) + ' 条）');
      return r;
    } catch (e) {
      console.error('[Backup] 导出失败：', e);
      Toast.error('导出失败：' + e.message);
      return null;
    }
  }

  /* --------------------------------------------------------------------------
     导入
       mode: 'replace' | 'merge'
         replace  清空现有数据后导入（默认）
         merge    按幂等键合并，不删除已有数据
     -------------------------------------------------------------------------- */
  async function importJson(text, mode, cfg) {
    let o;
    try { o = JSON.parse(text); }
    catch (e) { throw new Error('JSON 解析失败：' + e.message); }

    if (!o || o.manifest == null) throw new Error('不是 Lava_test 备份文件（缺少 manifest）');
    if (o.manifest.format && o.manifest.format !== FORMAT) {
      throw new Error('备份格式不匹配：' + o.manifest.format);
    }

    const m = o.manifest;
    const result = { slots: 0, config: false, records: 0, bad: 0, error: 0,
                     judgements: 0, workOrders: 0, warnings: [] };

    /* --- 配置 --- */
    if (o.config) {
      const keepUi = mode === 'merge';
      Object.keys(o.config).forEach(k => {
        if (k === 'ui' && keepUi) return;         // 合并时不覆盖当前界面偏好
        if (o.config[k] !== undefined) cfg[k] = Util.clone(o.config[k]);
      });
      result.config = true;
      // 拓扑可能因配置变化而改变，必须失效缓存
      Topology.invalidate();
    }

    /* --- 盘位 --- */
    if (Array.isArray(o.slots) && o.slots.length) {
      if (mode === 'replace') await Repo.clearSlots();

      const cols = o.slotColumns || SLOT_COLS;
      const rows = o.slots.map(r => {
        const obj = {};
        cols.forEach((c, i) => { obj[c] = (r[i] === '' ? null : r[i]); });
        return obj;
      });

      const topo = Topology.all(cfg);
      // 拓扑容量与备份不一致时给出警告，但不中断（仍按 key 精确恢复）
      if (m.counts && m.counts.slotCapacity && m.counts.slotCapacity !== topo.totalSlots) {
        result.warnings.push(
          '备份的盘位总容量（' + m.counts.slotCapacity + '）与当前拓扑（' + topo.totalSlots +
          '）不一致。盘位按 key 精确恢复，超出当前拓扑的条目会被跳过；' +
          '建议先应用备份中的工站配置再导入。');
      }

      const validKeys = new Set();
      const toWrite = [];
      rows.forEach(obj => {
        const key = obj.key;
        if (!key) return;
        const p = Schema.parseSlotKey(key);
        const eqs = topo.stationsMap[p.station];
        if (!eqs) { result.warnings.push('备份含未知工站 ' + p.station + '，已跳过'); return; }
        const eq = eqs.filter(e => e.id === p.equipmentId)[0];
        if (!eq || p.slotIndex >= eq.capacity) {
          result.warnings.push('备份含当前拓扑不存在的盘位 ' + key + '，已跳过');
          return;
        }
        validKeys.add(key);
        toWrite.push(Schema.newSlot(Object.assign({
          station: p.station, equipmentId: p.equipmentId, slotIndex: p.slotIndex
        }, obj)));
      });

      // 分块写，避免一次性构造上万个对象卡住主线程
      const CH = 3000;
      for (let i = 0; i < toWrite.length; i += CH) {
        await Repo.putSlots(toWrite.slice(i, i + CH));
      }
      result.slots = toWrite.length;
      result.skipped = rows.length - toWrite.length;
    } else if (mode === 'replace') {
      await Repo.clearSlots();
    }

    /* --- 记录表 --- */
    async function putTable(store, key, list) {
      if (!Array.isArray(list) || !list.length) return 0;
      if (mode === 'replace') await Repo.clearTable(store);
      let n = 0;
      const CH = 2000;
      for (let i = 0; i < list.length; i += CH) {
        n += await Repo.putMany(store, list.slice(i, i + CH));
      }
      return n;
    }
    result.records    = await putTable('records', null, o.records);
    result.bad        = await putTable('bad', null, o.bad);
    result.error      = await putTable('error', null, o.error);
    result.judgements = await putTable('judgements', null, o.judgements);
    if (o.archives)   await putTable('archives', null, o.archives);
    if (o.logindex)   await putTable('logindex', null, o.logindex);

    if (Array.isArray(o.workOrders)) {
      result.workOrders = o.workOrders.length;
    }

    result.manifest = m;
    return result;
  }

  /* 从文件读入并导入 */
  function pickAndImport(cfg, mode) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return resolve(null);
        try {
          Toast.info('正在读取 ' + f.name + '（' + Util.bytes(f.size) + '）…');
          const text = await f.text();
          const r = await importJson(text, mode || 'replace', cfg);
          resolve(r);
        } catch (e) {
          console.error('[Backup] 导入失败：', e);
          Toast.error('导入失败：' + e.message);
          resolve(null);
        }
      };
      input.click();
    });
  }

  return {
    FORMAT, FORMAT_VERSION, SLOT_COLS,
    exportData, download, importJson, pickAndImport, filename,
    packSlots, unpackSlots
  };
})();
