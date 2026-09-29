/* ============================================================================
   追溯 —— 正向 / 反向 / 同箱 / 同柜
   ----------------------------------------------------------------------------
   与 RDIMM 的差异（规范 §9）：RDIMM 追溯「这个位置上的东西对不对」，
   Lava_test 追溯「这块盘走到哪了、卡在哪」，并且**多了连带追溯**：
     单箱 256 盘、单柜 144 盘 —— 一次设备异常的影响面是数十到数百块盘。
   这是单件流产线没有的场景，也是「整箱连带判废」规则的依据。
   ============================================================================ */

const Trace = (() => {

  /* --------------------------------------------------------------------------
     反向追溯：给定 SN，还原它在各工站的记录
     返回按时间正序的工序流转链
     -------------------------------------------------------------------------- */
  function bySn(sn, records) {
    const list = (records || []).filter(r => r.sn === sn);
    list.sort((a, b) => (a.time || 0) - (b.time || 0));

    // 按工站归并（同一站可能有多条：首测 + 复测）
    const byStation = {};
    list.forEach(r => {
      const st = MatchEngine.normalizeStation(null, r.station) || r.station || '未知';
      (byStation[st] = byStation[st] || []).push(r);
    });

    // 按主线顺序 + ORT 输出
    const order = MAINLINE.concat(['ORT']);
    const chain = [];
    order.forEach(st => {
      const recs = byStation[st];
      if (!recs || !recs.length) {
        chain.push({ station: st, state: 'pending', records: [] });
        return;
      }
      const last = recs[recs.length - 1];
      const res = String(last.result || '').toUpperCase();
      chain.push({
        station: st,
        state: res === 'PASS' ? 'pass' : res === 'FAIL' ? 'fail' : res === 'ABORT' ? 'abort' : 'unknown',
        first: recs[0],
        last,
        records: recs,
        retest: recs.length > 1 ? recs.length - 1 : 0,
        // 复测次数 > 0 时说明该站测了多次
        detail: recs.length > 1 ? `测 ${recs.length} 次（复测 ${recs.length - 1} 次）` : ''
      });
    });

    // ORT 属旁路，若没有记录则标注为未抽中
    const ortIdx = chain.findIndex(c => c.station === 'ORT');
    if (ortIdx >= 0 && chain[ortIdx].state === 'pending') {
      chain[ortIdx].bypass = true;
      chain[ortIdx].detail = Sampling.isSampled(sn)
        ? '已抽中，等待排轮' : '未抽中（2.5% 抽样）';
    }

    const first = list[0], last = list[list.length - 1];
    return {
      sn,
      chain,
      records: list,
      count: list.length,
      stations: Object.keys(byStation),
      pn: first ? first.pn : '',
      model: first ? first.model : '',
      woNo: first ? first.woNo : '',
      firstTime: first ? first.time : null,
      lastTime: last ? last.time : null,
      hasFail: list.some(r => String(r.result || '').toUpperCase() === 'FAIL'),
      hasAbort: list.some(r => String(r.result || '').toUpperCase() === 'ABORT')
    };
  }

  /* --------------------------------------------------------------------------
     正向追溯：给定工单号，列出其下全部产品及当前分布
     -------------------------------------------------------------------------- */
  function byWorkOrder(woNo, records, slots) {
    const recs = (records || []).filter(r => r.woNo === woNo);
    const sl = (slots || []).filter(s => s.woNo === woNo);
    const snSet = {};
    recs.forEach(r => { if (r.sn) snSet[r.sn] = (snSet[r.sn] || 0) + 1; });
    const sns = Object.keys(snSet);

    // 当前所在工站分布
    const atStation = {};
    sl.forEach(s => { atStation[s.station] = (atStation[s.station] || 0) + 1; });

    return {
      woNo,
      snCount: sns.length,
      recordCount: recs.length,
      slotCount: sl.length,
      atStation,
      sns,
      records: recs.sort((a, b) => (b.time || 0) - (a.time || 0)),
      slots: sl
    };
  }

  /* --------------------------------------------------------------------------
     同箱追溯 ★ Lava_test 特有
     给定箱号/机柜号 + 可选时间窗，列出同箱全部产品
     用于箱体异常（温控失效等）时的**连带判定**
     -------------------------------------------------------------------------- */
  function byBox(boxId, records, slots, timeWindow) {
    const sl = (slots || []).filter(s => s.boxId === boxId && s.state !== 'empty');
    const sns = sl.map(s => s.sn).filter(Boolean);
    let recs = (records || []).filter(r => r.boxId === boxId);
    if (timeWindow) {
      const from = timeWindow.from || 0, to = timeWindow.to || Date.now();
      recs = recs.filter(r => (r.time || 0) >= from && (r.time || 0) <= to);
    }
    const counts = Capacity.countSlots(sl);
    return {
      boxId, scope: 'box',
      slotCount: sl.length,
      capacity: sl.length ? (ST[sl[0].station] ? ST[sl[0].station].capacity : null) : null,
      sns, records: recs,
      counts,
      yieldPct: Capacity.yieldOf(counts).pct,
      // 连带影响面：箱体异常时需整箱复测
      impact: `${boxId} 内 ${sl.length} 块产品同受该箱体工况影响`
    };
  }

  /* --------------------------------------------------------------------------
     同柜追溯 —— 一个机柜 9 台服务器 × 16 盘位 = 144 盘位
     -------------------------------------------------------------------------- */
  function byCabinet(cfg, cabinetId, records, slots) {
    const cabs = Topology.cabinets(cfg).filter(c => c.id === cabinetId);
    if (!cabs.length) return null;
    const cab = cabs[0];
    const keys = new Set();
    cab.servers.forEach(sv => {
      for (let i = 0; i < sv.capacity; i++) keys.add(Schema.slotKey(sv.station, sv.id, i));
    });
    const sl = (slots || []).filter(s => keys.has(s.key) && s.state !== 'empty');
    const recs = (records || []).filter(r => r.cabinetId === cabinetId);
    const counts = Capacity.countSlots(sl);
    return {
      cabinetId, scope: 'cabinet',
      station: cab.station,
      serverCount: cab.servers.length,
      slotCapacity: cab.slotCount,
      slotCount: sl.length,
      counts,
      yieldPct: Capacity.yieldOf(counts).pct,
      records: recs,
      sns: sl.map(s => s.sn).filter(Boolean),
      servers: cab.servers.map(sv => {
        const sub = sl.filter(s => s.serverId === sv.id);
        return { id: sv.id, capacity: sv.capacity, used: sub.length, counts: Capacity.countSlots(sub) };
      }),
      impact: `${cabinetId} 内 ${cab.servers.length} 台服务器 / ${sl.length} 块在测产品同受影响`
    };
  }

  /* --------------------------------------------------------------------------
     通用检索：按任意关键词跨维度查
     对应 RDIMM 的 mxTraceSearch
     -------------------------------------------------------------------------- */
  function search(query, deps) {
    const raw = String(query || '').trim();
    if (!raw) return null;
    // 支持多关键词，空格/逗号分隔，任一命中即算
    const terms = raw.split(/[\s,，;；|]+/).filter(Boolean).map(t => t.toUpperCase());
    const hit = v => {
      const s = String(v == null ? '' : v).toUpperCase();
      return terms.some(t => s.indexOf(t) >= 0);
    };

    const recs  = (deps.records || []).filter(r =>
      hit(r.sn) || hit(r.pn) || hit(r.woNo) || hit(r.station) ||
      hit(r.errCode) || hit(r.sourceFile) || hit(r.cabinetId) || hit(r.serverId));
    const bads  = (deps.bad || []).filter(b =>
      hit(b.sn) || hit(b.pn) || hit(b.woNo) || hit(b.type) || hit(b.errCode) || hit(b.note));
    const errs  = (deps.error || []).filter(e =>
      hit(e.sn) || hit(e.type) || hit(e.message) || hit(e.errCode) || hit(e.cabinetId) || hit(e.equipmentId));
    const slots = (deps.slots || []).filter(s =>
      s.state !== 'empty' && (hit(s.sn) || hit(s.pn) || hit(s.woNo) || hit(s.cabinetId) || hit(s.serverId)));

    // SN 出现次数（用于排序「问题最多的盘」）
    const snCount = {};
    [recs, bads, errs].forEach(arr => arr.forEach(x => {
      if (x.sn) snCount[x.sn] = (snCount[x.sn] || 0) + 1;
    }));

    // 时间线：测试 + 不良 + 报错合并，按时间倒序
    const timeline = []
      .concat(recs.map(r => ({ kind: 'test', time: r.time, station: r.station, sn: r.sn,
                               result: r.result, text: `${r.station} 测试 ${r.result || ''}`, ref: r })))
      .concat(bads.map(b => ({ kind: 'bad', time: b.time, station: b.station, sn: b.sn,
                               result: 'FAIL', text: `不良：${b.type}`, ref: b })))
      .concat(errs.map(e => ({ kind: 'error', time: e.time, station: e.station, sn: e.sn,
                               result: 'ABORT', text: `报错：${e.type}`, ref: e })))
      .sort((a, b) => (b.time || 0) - (a.time || 0));

    return {
      query: raw, terms,
      records: recs, bads, errs, slots,
      snCount,
      timeline,
      summary: {
        records: recs.length, bads: bads.length, errs: errs.length,
        slots: slots.length, sns: Object.keys(snCount).length
      }
    };
  }

  /* 快捷检索标签：不良最多的 SN + 常见机柜 */
  function quickChips(deps, n) {
    const limit = n || 6;
    const cnt = {};
    (deps.bad || []).forEach(b => { if (b.sn) cnt[b.sn] = (cnt[b.sn] || 0) + 1; });
    const topSn = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, limit)
      .map(sn => ({ label: sn, value: sn, count: cnt[sn] }));
    const cabCnt = {};
    (deps.error || []).forEach(e => { if (e.cabinetId) cabCnt[e.cabinetId] = (cabCnt[e.cabinetId] || 0) + 1; });
    const topCab = Object.keys(cabCnt).sort((a, b) => cabCnt[b] - cabCnt[a]).slice(0, limit)
      .map(c => ({ label: c, value: c, count: cabCnt[c] }));
    return topSn.concat(topCab);
  }

  return { bySn, byWorkOrder, byBox, byCabinet, search, quickChips };
})();
