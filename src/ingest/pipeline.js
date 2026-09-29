/* ============================================================================
   入库流水线
   ----------------------------------------------------------------------------
   解析 → 归一 → 幂等去重 → 落库 → 不良判定

   幂等是重点：同一份日志被拉两次、或两个通道都覆盖到同一个文件，
   都不该产生重复记录。靠 ingest_ledger 表的唯一键拦截
   （键 = SN|工站|结束时间，缺则退化为 来源文件|行号）。

   归一化的意义：不论源格式是什么，落库前都变成同一个形状，
   下游的判定 / 统计 / 追溯完全不关心日志长什么样。
   ============================================================================ */

const Pipeline = (() => {

  /* 最近一次入库的统计（供界面显示「写入 N 个盘位」这类信息） */
  let lastStats = null;

  /* --------------------------------------------------------------------------
     归一化
     -------------------------------------------------------------------------- */
  function normalize(raw, ctx) {
    const r = raw || {};
    const cfg = App.cfg;

    const station = MatchEngine.normalizeStation(cfg, r.station || ctx.station || '');
    const sn = String(r.sn || '').trim();
    if (!sn || !station) return null;              // 缺 SN 或工站，无法定位，丢弃

    const result = String(r.result || '').toLowerCase();
    const okResult = ['pass', 'fail', 'abort'].indexOf(result) >= 0 ? result : '';

    /* 位置：优先用日志给的信息，其次按 IP 反查。
       ⚠️ IP 反查优先走**设备台账**（Registry）—— 那是现场真实设备的权威来源，
          440 台设备都带 IP；matchRules.ipToLocation 只是没有台账时的手工映射。 */
    let equipmentId = r.equipmentId || '';
    let cabinetId = r.cabinetId || '';
    if (!equipmentId && r.ip) {
      const dev = _deviceByIp(r.ip);
      if (dev) {
        equipmentId = dev.id;
        cabinetId = dev.cabinet || '';
      } else {
        const loc = MatchEngine.locationOfIp(cfg, r.ip);
        if (loc) { equipmentId = loc.equipmentId || ''; cabinetId = loc.cabinetId || ''; }
      }
    }

    const startTime = _ts(r.startTime);
    const endTime = _ts(r.endTime || r.time);

    /* ⚠️ 兜底时间必须**确定性**，绝不能用 Date.now()。
       日志里没带时间戳时若用当前时间兜底，同一份日志每次解析出来的时间都不同，
       幂等键随之变化 —— 结果是同一份日志拉两次就入库两次，记录翻倍。
       改用「文件 mtime」兜底：同一个文件永远是同一个值。
       没有 mtime 时留 null，让 Schema.dedupKey 退回「来源文件 + 行号」作键。 */
    const fallbackTs = _ts(ctx.mtime) || null;
    const time = endTime || startTime || fallbackTs;
    const dayTs = time || Date.now();

    const rec = {
      sn,
      station,
      equipmentId,
      cabinetId,
      slotIndex: r.slotIndex == null ? null : Number(r.slotIndex),
      result: okResult ? okResult.toUpperCase() : '',
      pn: r.pn || '',
      model: MatchEngine.modelOf(cfg, (r.pn || '') + ' ' + (r.model || '')) || r.model || '',
      woNo: r.woNo || '',
      errCode: r.errCode || ErrCodeRules.extract(r.rawText || r.note || ''),
      startTime,
      endTime,
      time,
      // 日期仅用于分组统计；时间未知时归到「今天」不影响幂等（键不含 day）
      day: Util.todayKey(new Date(dayTs)),
      timeUnknown: !time,
      rawText: Util.truncate(r.rawText || '', 500),
      sourceFile: ctx.fileName || r.sourceFile || '',
      lineNo: r.lineNo == null ? null : r.lineNo,
      source: ctx.source || r.source || 'ftp',
      handled: false
    };
    rec.dedupKey = Schema.dedupKey(rec);
    return rec;
  }

  function _ts(v) {
    if (!v) return null;
    if (typeof v === 'number') return v;
    const d = new Date(String(v).replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  /* 设备台账的 IP 索引（缓存；台账变化时由 invalidate 清掉） */
  let _ipIndex = null;
  function _deviceByIp(ip) {
    if (!ip) return null;
    if (!_ipIndex) {
      _ipIndex = {};
      (App.devices || []).forEach(d => {
        if (d.ip) _ipIndex[d.ip] = d;
        if (d.ipAlt) _ipIndex[d.ipAlt] = d;
      });
    }
    return _ipIndex[ip] || null;
  }
  function invalidateIndex() { _ipIndex = null; }

  /* --------------------------------------------------------------------------
     记录 → 盘位
     ----------------------------------------------------------------------------
     ⚠️ 这一步早先是缺的：解析出的记录只进了 records 表，
        平面图上的盘位状态**永远不变**。端到端演练才暴露出来 ——
        每段单独测都过，但从没验证过「拉完日志看板该变」。

     定位盘位需要两个东西：设备编号 + 位号。缺任一就跳过该条 ——
     宁可不写，也不能猜错位置把状态写到别的盘上。

     遵循「无变化不改动」：内容一致就跳过，避免无谓写盘与重绘。
     -------------------------------------------------------------------------- */
  const RESULT_TO_STATE = { pass: 'pass', fail: 'fail', abort: 'abort' };

  async function applyToSlots(recs, deps) {
    const d = deps || {};
    const cfg = d.cfg || App.cfg;
    const slots = d.slots || App.slots;
    const saveSlots = d.saveSlots || (s => App.saveSlots(s));

    const topo = Topology.all(cfg);
    const eqIndex = {};
    topo.equipment.forEach(eq => { eqIndex[eq.station + '|' + eq.id] = eq; });

    const stats = { applied: 0, unchanged: 0, skipNoPos: 0, skipNoEq: 0, skipRange: 0 };
    const updates = new Map();

    (recs || []).forEach(r => {
      if (!r.equipmentId || r.slotIndex == null) { stats.skipNoPos++; return; }
      const idx = Number(r.slotIndex);
      const eq = eqIndex[r.station + '|' + r.equipmentId];
      if (!eq) { stats.skipNoEq++; return; }
      if (!(idx >= 0 && idx < eq.capacity)) { stats.skipRange++; return; }

      const key = eq.slotKeys[idx];
      const prev = slots.get(key);
      const state = RESULT_TO_STATE[String(r.result || '').toLowerCase()] || '';

      // 无变化不改动 —— 同一份日志反复拉取时不该产生任何写盘
      if (prev && prev.sn === r.sn && prev.state === state &&
          prev.endTime === (r.endTime || null) && prev.result === (r.result || '')) {
        stats.unchanged++;
        return;
      }

      updates.set(key, Schema.newSlot({
        station: r.station,
        equipmentId: r.equipmentId,
        slotIndex: idx,
        cabinetId: eq.cabinetId || '',
        serverId: eq.serverId || '',
        boxId: eq.boxId || '',
        state: state || 'testing',
        sn: r.sn, pn: r.pn, model: r.model, woNo: r.woNo,
        result: r.result || '',
        errCode: r.errCode || '',
        startTime: r.startTime || null,
        endTime: r.endTime || null,
        retestRound: 0,
        source: r.source || ''
      }));
      stats.applied++;
    });

    if (updates.size) {
      const list = Array.from(updates.values());
      const CH = 3000;
      for (let i = 0; i < list.length; i += CH) {
        await saveSlots(list.slice(i, i + CH));
      }
    }
    return stats;
  }

  /* --------------------------------------------------------------------------
     主流程
     -------------------------------------------------------------------------- */
  async function ingest(text, ctx) {
    const c = ctx || {};
    const info = { name: c.fileName || '', head: String(text).slice(0, 2000), size: String(text).length };

    const parser = ParserRegistry.pick(info);
    if (!parser) {
      // 注册表里连通用解析器都没有 —— 不该发生，但仍要安全返回
      return 0;
    }

    const raws = ParserRegistry.run(parser, text, c);
    if (!raws.length) {
      // 解析不出记录也要留下索引，便于人工查看
      await Repo.put('logindex', Schema.newLogIndex({
        path: c.filePath || c.fileName || '',
        name: c.fileName || '', station: c.station || '',
        size: info.size, mtime: c.mtime || null,
        pulledAt: Date.now(), parsed: 0, hits: {}, error: '未解析出记录'
      }));
      return 0;
    }

    const recs = [];
    raws.forEach(r => {
      const n = normalize(r, c);
      if (n) recs.push(n);
    });

    /* 幂等：先用台账过滤掉已入库的，再写 */
    const keys = recs.map(r => r.dedupKey);
    const seen = new Set(await Repo.ledgerFilter(keys));
    const fresh = recs.filter(r => !seen.has(r.dedupKey));

    if (fresh.length) {
      await Repo.putMany('records', fresh);
      await Repo.ledgerMark(fresh.map(r => r.dedupKey));
    }

    /* 不良判定：FAIL 的记录走判定引擎 */
    let badCount = 0;
    const deps = App.defectDeps();
    for (const r of fresh) {
      if (r.result !== 'FAIL') continue;
      try {
        const j = await DefectEngine.record({
          source: r.source,
          rawText: r.rawText,
          errCode: r.errCode,
          station: r.station,
          sn: r.sn,
          pn: r.pn,
          model: r.model,
          woNo: r.woNo,
          cabinetId: r.cabinetId,
          serverId: r.equipmentId,
          slotIndex: r.slotIndex,
          time: r.time
        }, deps);
        if (j && j.badId) badCount++;
      } catch (e) {
        console.warn('[Pipeline] 判定失败：', e.message);
      }
    }

    /* ---- 记录 → 盘位 ----
       没有这一步，拉再多日志平面图也不会变。 */
    const slotStats = await applyToSlots(fresh);

    /* 日志索引 */
    const scan = Highlight.scan(App.cfg, text, 300);
    await Repo.put('logindex', Schema.newLogIndex({
      path: c.filePath || c.fileName || '',
      name: c.fileName || '', station: c.station || '',
      size: info.size, mtime: c.mtime || null,
      pulledAt: Date.now(),
      parsed: fresh.length,
      hits: scan.summary
    }));

    App.invalidate('records');
    App.invalidate('bad');
    App.invalidate('logindex');
    Bus.emit(EVT.RECORDS_CHANGED, { store: 'records', count: fresh.length });

    /* 返回值保持「新增记录数」（兼容既有调用方），
       详细的落盘情况挂在 lastStats 上供诊断。 */
    lastStats = {
      records: fresh.length,
      slots: slotStats.applied,
      slotsUnchanged: slotStats.unchanged,
      skipNoPos: slotStats.skipNoPos,
      skipNoEq: slotStats.skipNoEq,
      bad: badCount
    };
    return fresh.length;
  }

  /* --------------------------------------------------------------------------
     手工导入：把一串文本走同一套流程
     -------------------------------------------------------------------------- */
  async function ingestManual(text, name) {
    return ingest(text, {
      fileName: name || '手工导入',
      filePath: '',
      source: 'manual'
    });
  }

  return {
    ingest, ingestManual, normalize,
    applyToSlots,          // 记录 → 盘位（独立出来便于单测与手工触发）
    stats: () => lastStats,
    invalidateIndex        // 设备台账变化后清 IP 索引缓存
  };
})();
