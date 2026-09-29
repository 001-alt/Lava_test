/* ============================================================================
   错误码规则引擎 —— 每条码带「处置策略」而不只是文案
   ----------------------------------------------------------------------------
   对应 RDIMM 的 ERROR_CODE_RULES。策略决定：是否允许复测、是否锁定 SN。
   ⚠️ 具体错误码待现场提供（规范 §10）。现场可用「系统设置 → 错误码规则」覆盖。
   ============================================================================ */

const ErrCodeRules = (() => {

  /* 生效规则 = 内置 + 配置覆盖（按 code 合并） */
  function effective(cfg) {
    const over = (cfg && cfg.errorCodeRules) || [];
    if (!over.length) return ERROR_CODE_RULES.slice();
    const map = new Map();
    ERROR_CODE_RULES.forEach(r => map.set(r.code, Object.assign({}, r)));
    over.forEach(r => {
      if (!r || !r.code) return;
      const base = map.get(r.code) || {};
      map.set(r.code, Object.assign({}, base, r));
    });
    return Array.from(map.values());
  }

  function find(cfg, code) {
    if (!code) return null;
    const c = String(code).trim().toUpperCase();
    return effective(cfg).filter(r => String(r.code).toUpperCase() === c)[0] || null;
  }

  /* 从任意文本里提取错误码
     ⚠️ 占位模式：现有 E-XXX-nnn 与 0xXXXX 两种形态，现场确定后收紧 */
  const CODE_RES = [
    /\bE-[A-Z]{2,6}-\d{2,4}\b/i,          // E-ICT-102 / E-BIST-407
    /\b0x[0-9A-F]{4}\b/i,                 // 0x000B 一类
    /\bERR[-_]?\d{3,5}\b/i                // ERR-1234
  ];
  /* 归一化：十六进制只大写数字部分，保留小写 x（'0X000B' 显示很别扭）；
     其余形态整体大写。判定时都按大写比较，故不影响匹配。 */
  function normalizeCode(c) {
    const s = String(c || '');
    if (/^0x/i.test(s)) return '0x' + s.slice(2).toUpperCase();
    return s.toUpperCase();
  }
  function extract(text) {
    if (!text) return '';
    const s = String(text);
    for (let i = 0; i < CODE_RES.length; i++) {
      const m = s.match(CODE_RES[i]);
      if (m) return normalizeCode(m[0]);
    }
    return '';
  }

  /* 该错误码是否允许复测 */
  function allowRetest(cfg, code) {
    const r = find(cfg, code);
    return r ? !!r.allowRetest : false;   // 未知码一律不允许复测，走人工
  }
  /* 该错误码是否应锁定 SN */
  function lockSn(cfg, code) {
    const r = find(cfg, code);
    return r ? !!r.lockSn : false;
  }
  /* 处置动作文案 */
  function actionOf(cfg, code) {
    const r = find(cfg, code);
    return r ? (r.action || '') : '未知错误码，请人工判定';
  }
  function nameOf(cfg, code) {
    const r = find(cfg, code);
    return r ? (r.name || r.code) : '';
  }

  /* 复测裁决：给定当前复测轮次与错误码，返回是否可再测 */
  function canRetest(cfg, code, retestRound) {
    const round = retestRound || 0;
    if (!allowRetest(cfg, code)) {
      return { ok: false, reason: '该错误码不允许复测，须直接转 FA' };
    }
    const MAX = 1;   // 🟡 推定上限 1 次（规范 §6.2，待现场确认）
    if (round >= MAX) {
      return { ok: false, reason: `已达复测上限（${MAX} 次）` };
    }
    return { ok: true, reason: '', action: actionOf(cfg, code) };
  }

  return { effective, find, extract, normalizeCode, allowRetest, lockSn, actionOf, nameOf, canRetest };
})();
