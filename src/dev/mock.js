/* ============================================================================
   模拟数据生成器 —— 用于界面验收与开发调试
   ----------------------------------------------------------------------------
   与 RDIMM 的 dev-testdata.js 同定位，但改进了两点：
     · 用确定性种子，同一 seed 产出完全一致的数据，便于复现问题
     · 盘位数据量大（12,737），生成后只写非空盘位，避免无谓占用

   ⚠️ 这是开发工具，会在真实库里写入假数据。
      正式使用前请到「导出中心 → 清空数据」清掉。
   ============================================================================ */

const Mock = (() => {

  const PN_POOL = [
    { pn: 'LVA-SSD-960G-A1', model: 'Lava 960G' },
    { pn: 'LVA-SSD-1T92-B3', model: 'Lava 1.92T' },
    { pn: 'LVA-SSD-3T84-C2', model: 'Lava 3.84T' },
    { pn: 'LVA-SSD-7T68-D1', model: 'Lava 7.68T' }
  ];
  const WO_POOL = [
    { no: 'WO26092901', pi: 1, qty: 1000, customer: '标准订单' },
    { no: 'WO26092807', pi: 0, qty: 500,  customer: '标准订单' },
    { no: 'WO26092912', pi: 2, qty: 300,  customer: '定制订单' }
  ];
  /* 各工站典型装载率（贴近真实节拍：箱类接近满载，服务器类略低） */
  const FILL = { ICT: 0.90, FUNCTION: 0.85, BIST: 0.94, ESS: 0.92,
                 FINAL: 0.78, ORT: 0.90, CUS: 0.82 };

  let _rnd = Math.random;
  let _seq = 0;
  function ri(a, b) { return a + Math.floor(_rnd() * (b - a + 1)); }
  function pick(a) { return a[Math.floor(_rnd() * a.length)]; }
  function sn() { _seq++; return 'LVA260929-' + Util.pad(_seq, 5); }

  /* --------------------------------------------------------------------------
     生成一套完整数据并写库
       opts: { seed, onProgress }
       onProgress: (done, total, label)
     -------------------------------------------------------------------------- */
  async function generate(cfg, opts) {
    const o = opts || {};
    const seed = o.seed || 20260929;
    _rnd = Util.seededRandom(seed);
    _seq = 0;

    const topo = Topology.all(cfg);
    const now = Date.now();
    const slotBatch = [];
    const records = [];
    const bad = [];
    const error = [];
    const logindex = [];
    const total = topo.totalSlots;
    let done = 0;

    /* 设备状态：同柜服务器状态相关，模拟「整柜掉线」这类真实故障 */
    const eqStates = {};
    topo.equipment.forEach(eq => {
      const roll = _rnd();
      let st = 'run';
      if (roll < 0.05) st = 'fault';
      else if (roll < 0.09) st = 'maint';
      else if (_rnd() < 0.10) st = 'idle';
      eqStates[eq.id] = st;
    });

    topo.equipment.forEach(eq => {
      const s = ST[eq.station];
      const eqState = eqStates[eq.id];
      const base = FILL[eq.station] || 0.8;
      let fill;
      if (eqState === 'idle')       fill = _rnd() * 0.35;
      else if (eqState === 'maint') fill = _rnd() * 0.08;
      else                          fill = Math.min(1, base + (_rnd() - 0.5) * 0.22);
      const occupied = Math.round(eq.capacity * fill);

      for (let i = 0; i < eq.capacity; i++) {
        done++;
        if (i >= occupied) continue;               // 空位不落库

        const wo = WO_POOL[Math.floor(_rnd() * WO_POOL.length)];
        const pn = PN_POOL[wo.pi];
        const snv = sn();

        // 状态分布：多数在测，少量通过/失败/异常
        const r = _rnd();
        let state;
        if (eqState === 'fault' && i < 4) state = 'abort';
        else if (r < 0.70) state = 'testing';
        else if (r < 0.955) state = 'pass';
        else if (r < 0.965) state = 'fail';
        else state = 'abort';

        const progress = state === 'testing' ? 0.05 + _rnd() * 0.9 : (state === 'pass' || state === 'fail' ? 1 : 0.4);
        const startTime = now - s.cycleMin * 60000 * progress;
        const endTime = (state === 'pass' || state === 'fail') ? startTime + s.cycleMin * 60000 : null;
        const errCode = state === 'fail'
          ? pick(['E-ICT-102', 'E-FN-311', 'E-BIST-407', 'E-ESS-220', 'E-CUS-118'])
          : '';
        const result = state === 'pass' ? 'pass' : state === 'fail' ? 'fail'
                     : state === 'abort' ? 'abort' : '';

        slotBatch.push(Schema.newSlot({
          station: eq.station, equipmentId: eq.id, slotIndex: i,
          cabinetId: eq.cabinetId, serverId: eq.serverId, boxId: eq.boxId,
          state, sn: snv, pn: pn.pn, model: pn.model, woNo: wo.no,
          result, errCode, startTime, endTime,
          retestRound: state === 'fail' && _rnd() < 0.3 ? 1 : 0,
          source: 'mock'
        }));

        /* 测试记录：每条非在测的盘位都有记录 */
        if (result) {
          records.push(Object.assign({}, Schema.newSlot({}), {}, {
            dedupKey: Schema.dedupKey({ sn: snv, station: eq.station, endTime: endTime || startTime }),
            sn: snv, station: eq.station, result: result.toUpperCase(),
            pn: pn.pn, model: pn.model, woNo: wo.no,
            cabinetId: eq.cabinetId, serverId: eq.serverId, boxId: eq.boxId,
            slotIndex: i, errCode,
            time: endTime || startTime, day: Util.todayKey(new Date(endTime || startTime)),
            source: 'mock', handled: _rnd() < 0.7
          }));
        }
      }

      if (o.onProgress && done % 4000 < eq.capacity) o.onProgress(done, total, eq.station);
    });

    /* 按工站 / 日期 / 工单限制 FAIL 数量，防止小样本的随机波动让良率低于 95%。
       口径与看板一致：PASS / (PASS + FAIL)，在测与 ABORT 不入分母。
       在派生不良前同步修正盘位和记录，保证各处显示的结果一致。 */
    const resultGroups = new Map();
    const slotsBySn = new Map(slotBatch.map(x => [x.sn, x]));
    records.forEach(rec => {
      if (rec.result !== 'PASS' && rec.result !== 'FAIL') return;
      const key = JSON.stringify([rec.station, rec.day, rec.woNo]);
      if (!resultGroups.has(key)) resultGroups.set(key, { total: 0, fails: [] });
      const group = resultGroups.get(key);
      group.total++;
      if (rec.result === 'FAIL') group.fails.push(rec);
    });
    resultGroups.forEach(group => {
      const maxFails = Math.floor(group.total / 20);
      // 用同一随机种子选取保留的失败样本，避免偏向前面的设备。
      for (let i = group.fails.length - 1; i > 0; i--) {
        const j = ri(0, i);
        [group.fails[i], group.fails[j]] = [group.fails[j], group.fails[i]];
      }
      group.fails.slice(maxFails).forEach(rec => {
        rec.result = 'PASS';
        rec.errCode = '';
        const slot = slotsBySn.get(rec.sn);
        slot.state = 'pass';
        slot.result = 'pass';
        slot.errCode = '';
        slot.retestRound = 0;
      });
    });

    /* 不良记录：从 FAIL 盘位派生 */
    const failSlots = slotBatch.filter(x => x.state === 'fail');
    failSlots.forEach(x => {
      const judgementId = Util.uid('jdg');
      const verdict = 'functional';
      bad.push(Schema.newBad({
        station: x.station, cabinetId: x.cabinetId, serverId: x.serverId,
        slotIndex: x.slotIndex, boxId: x.boxId,
        sn: x.sn, pn: x.pn, model: x.model, woNo: x.woNo,
        type: pick(['ICT电气不良', '功能测试失败', '老化早期失效', '应力失效', '客制化失败']),
        errCode: x.errCode, verdict, confirmed: true,
        confirmedBy: '自动判定', confirmedAt: now, judgementId,
        time: x.endTime || now, source: 'mock'
      }));
    });
    /* 掺入一些待确认（unknown）不良，验证待确认队列 */
    const unknownCount = Math.min(24, Math.floor(failSlots.length * 0.18));
    for (let i = 0; i < unknownCount && i < failSlots.length; i++) {
      const x = failSlots[i];
      bad.push(Schema.newBad({
        station: x.station, cabinetId: x.cabinetId, serverId: x.serverId,
        slotIndex: x.slotIndex, boxId: x.boxId,
        sn: x.sn, pn: x.pn, model: x.model, woNo: x.woNo,
        type: '待确认', errCode: '', verdict: 'unknown', confirmed: false,
        time: x.endTime || now, source: 'mock',
        note: '未命中任何判定规则，等待人工确认'
      }));
    }

    /* 报错记录：从 ABORT 盘位与故障设备派生 */
    slotBatch.filter(x => x.state === 'abort').slice(0, 60).forEach(x => {
      error.push(Schema.newError({
        station: x.station, cabinetId: x.cabinetId, serverId: x.serverId,
        boxId: x.boxId, equipmentId: x.equipmentId, slotIndex: x.slotIndex,
        sn: x.sn,
        type: pick(['设备通讯中断', '测试超时', '进程被中断', '箱体温度告警', '服务器掉线']),
        message: pick(['连接超时', '未收到结束信号', '进程异常退出', '温度超出阈值', '心跳丢失']),
        count: ri(1, 4), handled: _rnd() < 0.4,
        time: x.startTime || now, source: 'mock',
        dedupKey: [x.station, x.equipmentId, x.slotIndex, 'mock'].join('|')
      }));
    });
    Object.keys(eqStates).forEach(id => {
      if (eqStates[id] !== 'fault') return;
      const eq = topo.equipment.filter(e => e.id === id)[0];
      if (!eq) return;
      error.push(Schema.newError({
        station: eq.station, cabinetId: eq.cabinetId, serverId: eq.serverId,
        equipmentId: eq.id,
        type: '服务器掉线', message: '设备状态为故障，连续巡检无响应',
        count: ri(2, 9), handled: false, time: now - ri(1, 20) * 3600000,
        source: 'mock', dedupKey: [eq.station, eq.id, 'offline'].join('|')
      }));
    });

    /* 工单 */
    const workOrders = WO_POOL.map(w => {
      const wo = WorkOrder.create({
        no: w.no, pn: PN_POOL[w.pi].pn, model: PN_POOL[w.pi].model,
        qty: w.qty, customer: w.customer, status: 'running',
        acceptedBy: '张工', acceptedAt: now - 86400000
      });
      wo.status = 'running';
      return wo;
    });

    /* 日志索引 */
    const stationKeys = Topology.effectiveStations(cfg).map(s => s.key);
    stationKeys.forEach((st, i) => {
      logindex.push(Schema.newLogIndex({
        path: '/lava/logs/' + st + '/' + st + '_20260929_' + (120000 + i * 137) + '.log',
        name: st + '_20260929.log', station: st,
        size: ri(20000, 900000), parsed: ri(50, 900),
        hits: { PASS: ri(20, 400), FAIL: ri(0, 20), TIMEOUT: ri(0, 8) }
      }));
    });

    /* --------------------------------------------------------------------------
       写库：分块，避免一次性构造上万个对象阻塞主线程
       -------------------------------------------------------------------------- */
    await Repo.clearSlots();
    const CH = 3000;
    for (let i = 0; i < slotBatch.length; i += CH) {
      await Repo.putSlots(slotBatch.slice(i, i + CH));
      if (o.onProgress) o.onProgress(Math.min(total, done), total, '写入盘位 ' + (i + CH));
      await new Promise(r => setTimeout(r, 0));
    }

    await Repo.clearTable('records');
    for (let i = 0; i < records.length; i += 2000) {
      await Repo.putMany('records', records.slice(i, i + 2000));
    }
    await Repo.clearTable('bad');
    await Repo.putMany('bad', bad);
    await Repo.clearTable('error');
    await Repo.putMany('error', error);
    await Repo.clearTable('logindex');
    await Repo.putMany('logindex', logindex);
    /* 工单必须落库 —— 否则界面上的工单页会是空的 */
    await Repo.clearTable('workorders');
    await Repo.putMany('workorders', workOrders);
    await Repo.clearTable('ledger');
    await Repo.ledgerMark(records.map(r => r.dedupKey).slice(0, 50000));
    /* 盘位与记录分属两套表，台账也要标记，避免后续真实拉取重复入库 */
    await Repo.ledgerMark(slotBatch.map(s => s.key).slice(0, 50000));

    await Repo.metaSet('mockSeed', seed);
    await Repo.metaSet('mockAt', now);

    return {
      seed,
      slots: slotBatch.length,
      capacity: total,
      records: records.length,
      bad: bad.length,
      badPending: bad.filter(b => !b.confirmed).length,
      error: error.length,
      workOrders: workOrders.length,
      logindex: logindex.length,
      eqStates,
      workOrderList: workOrders
    };
  }

  /* 清空全部数据 */
  async function clearAll() {
    await Repo.clearAll();
    return true;
  }

  return { generate, clearAll, PN_POOL, WO_POOL };
})();
