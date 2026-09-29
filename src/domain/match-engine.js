/* ============================================================================
   匹配引擎 —— 把杂乱的日志/台账信息归一到系统内的位置与型号
   ----------------------------------------------------------------------------
   四类规则（全部可在界面配置，对应 RDIMM 的 matchRules）：
     stationAlias  工站别名归一   '功能测试' / 'FUNC' → 'FUNCTION'
     pnModel       PN/关键词 → 机型
     ipToLocation  IP → 工站/机柜/服务器/盘位
     keyExtract    从日志正文按正则抽字段
   ============================================================================ */

const MatchEngine = (() => {

  /* --------------------------------------------------------------------------
     工站别名归一
     内置一批常见写法，配置里的规则优先
     -------------------------------------------------------------------------- */
  const BUILTIN_ALIAS = [
    { pattern: '^(ICT|在线电路|电路测试)$', station: 'ICT' },
    { pattern: '^(FUNCTION|FUNC|FT|功能测试|功能)$', station: 'FUNCTION' },
    { pattern: '^(BIST|老化|烧机|Burn.?in)$', station: 'BIST' },
    { pattern: '^(ESS|环境应力|应力筛选|环筛)$', station: 'ESS' },
    { pattern: '^(FINAL|FT2|最终测试|终测)$', station: 'FINAL' },
    { pattern: '^(ORT|可靠性|抽检)$', station: 'ORT' },
    { pattern: '^(CUS|客制|客制化|定制)$', station: 'CUS' }
  ];

  function normalizeStation(cfg, raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const upper = s.toUpperCase();
    // 已是标准 key
    if (ST[upper]) return upper;
    // 配置规则优先
    const custom = (cfg && cfg.matchRules && cfg.matchRules.stationAlias) || [];
    for (const r of custom) {
      if (!r || !r.pattern) continue;
      try { if (new RegExp(r.pattern, 'i').test(s)) return r.station; } catch (e) { }
    }
    // 内置
    for (const r of BUILTIN_ALIAS) {
      try { if (new RegExp(r.pattern, 'i').test(s)) return r.station; } catch (e) { }
    }
    // 前缀兜底
    for (const k in ST) { if (upper.indexOf(k) === 0) return k; }
    return '';
  }

  /* --------------------------------------------------------------------------
     PN / 关键词 → 机型
     优先级：配置规则 > PN 预设（精确 > 包含）> 空
     -------------------------------------------------------------------------- */
  function modelOf(cfg, text) {
    const t = String(text || '').toUpperCase();
    if (!t) return '';
    const custom = (cfg && cfg.matchRules && cfg.matchRules.pnModel) || [];
    for (const r of custom) {
      if (r && r.key && t.indexOf(String(r.key).toUpperCase()) >= 0) return r.model;
    }
    const presets = (cfg && cfg.pnPresets) || [];
    // 精确优先
    for (const p of presets) {
      if (p.matchMode === 'exact' && t === String(p.pnCode).toUpperCase()) return p.workOrderType;
    }
    for (const p of presets) {
      if (p.matchMode !== 'exact' && t.indexOf(String(p.pnCode).toUpperCase()) >= 0) return p.workOrderType;
    }
    return '';
  }

  /* --------------------------------------------------------------------------
     IP → 位置
     查配置规则；未命中返回 null（由上层用文件名/台账兜底）
     -------------------------------------------------------------------------- */
  function locationOfIp(cfg, ip) {
    if (!ip) return null;
    const rules = (cfg && cfg.matchRules && cfg.matchRules.ipToLocation) || [];
    const hit = rules.filter(r => r && r.ip === ip)[0];
    if (!hit) return null;
    return {
      station: hit.station || '', cabinetId: hit.cabinetId || '',
      serverId: hit.serverId || '', slotIndex: hit.slotIndex == null ? null : hit.slotIndex,
      note: hit.note || '', source: 'ip-rule'
    };
  }

  /* --------------------------------------------------------------------------
     关键项正则抽取
     返回 { 字段名: 值 }，含位置信息便于定位
     -------------------------------------------------------------------------- */
  function extractKeys(cfg, text) {
    const out = {};
    const rules = (cfg && cfg.matchRules && cfg.matchRules.keyExtract) || [];
    const s = String(text || '');
    rules.forEach(r => {
      if (!r || !r.enabled || !r.regex) return;
      try {
        const m = s.match(new RegExp(r.regex, 'i'));
        if (m) out[r.key] = m[1] != null ? m[1] : m[0];
      } catch (e) { /* 非法正则跳过，不影响其它规则 */ }
    });
    return out;
  }

  /* --------------------------------------------------------------------------
     从文件名推断信息
     命名约定可配置；内置支持常见的
       工序_机柜_服务器_日期_时间_…
     例：FINAL_CAB-N-01_SRV-N-003_20260929_143021.log
     -------------------------------------------------------------------------- */
  /* ⚠️ 不能用 \b 划词边界：下划线属于 \w，'FINAL_CAB-N-01' 里 FINAL 与 _ 之间
     不存在 \b，会漏匹配。改用「非字母数字」显式边界，把 _ - . 都当分隔符。 */
  const B0 = '(?:^|[^A-Za-z0-9])';
  const B1 = '(?![A-Za-z0-9])';

  function fromFilename(cfg, name) {
    const base = Util.basename(name).replace(/\.[a-z0-9]+$/i, '');
    const out = { raw: base, station: '', cabinetId: '', serverId: '', boxId: '', date: '', time: '' };

    // 工站
    const stM = base.match(new RegExp(B0 + '(ICT|FUNCTION|FUNC|BIST|ESS|FINAL|ORT|CUS)' + B1, 'i'));
    if (stM) out.station = normalizeStation(cfg, stM[1]);

    // 机柜 / 服务器
    const cabM = base.match(new RegExp(B0 + 'CAB-([A-Z])-(\\d{1,3})' + B1, 'i'));
    if (cabM) out.cabinetId = 'CAB-' + cabM[1].toUpperCase() + '-' + Util.pad(Number(cabM[2]), 2);
    const srvM = base.match(new RegExp(B0 + 'SRV-([A-Z])-(\\d{1,3})' + B1, 'i'));
    if (srvM) out.serverId = 'SRV-' + srvM[1].toUpperCase() + '-' + Util.pad(Number(srvM[2]), srvM[2].length > 2 ? 3 : 2);
    // 箱体（BIST/ESS）
    const boxM = base.match(new RegExp(B0 + '(OVEN-B|ESS-E)-(\\d{1,3})' + B1, 'i'));
    if (boxM) out.boxId = boxM[1].toUpperCase() + '-' + Util.pad(Number(boxM[2]), 2);

    // 日期时间
    const dtM = base.match(/(\d{8})[_\-]?(\d{6})?/);
    if (dtM) {
      const d = dtM[1];
      out.date = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
      if (dtM[2]) out.time = dtM[2].slice(0, 2) + ':' + dtM[2].slice(2, 4) + ':' + dtM[2].slice(4, 6);
    }
    return out;
  }

  /* 由工站 + 设备号反推位置（用于日志只给了部分信息时补齐） */
  function completeLocation(cfg, loc) {
    const out = Object.assign({}, loc || {});
    if (!out.station || !out.equipmentId) return out;
    const eqs = Topology.all(cfg).stationsMap[out.station] || [];
    const eq = eqs.filter(e => e.id === out.equipmentId)[0];
    if (!eq) return out;
    out.cabinetId = out.cabinetId || eq.cabinetId || '';
    out.serverId = out.serverId || eq.serverId || '';
    out.boxId = out.boxId || eq.boxId || '';
    return out;
  }

  /* 匹配度打分（0-100），用于「机柜信息采纳最低匹配度」这类阈值判断 */
  function score(cfg, loc) {
    let s = 0;
    if (loc.station) s += 30;
    if (loc.equipmentId) s += 30;
    if (loc.cabinetId) s += 20;
    if (loc.slotIndex != null && loc.slotIndex >= 0) s += 20;
    return s;
  }
  function meetsThreshold(cfg, loc) {
    const min = (cfg && cfg.matchRules && cfg.matchRules.minScore) || 60;
    return score(cfg, loc) >= min;
  }

  return {
    normalizeStation, modelOf, locationOfIp,
    extractKeys, fromFilename, completeLocation,
    score, meetsThreshold, BUILTIN_ALIAS
  };
})();
