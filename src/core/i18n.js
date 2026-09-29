/* ============================================================================
   标签字典 —— 中文显示名集中管理
   ----------------------------------------------------------------------------
   避免同一状态在不同视图里写成不同中文（RDIMM 里出现过「维护中 / 维护」
   混用的情况）。所有面向用户的枚举中文都从这里取。
   ============================================================================ */

const L = (() => {

  function slotState(k) { return (SLOT_STATE[k] || { label: k }).label; }
  function eqState(k)   { return (EQ_STATE[k] || { label: k }).label; }
  function woState(k)   { return (WO_STATE[k] || { label: k }).label; }
  function verdict(k)   { return (VERDICT[k] || { label: k }).label; }
  function matchType(k) { return MATCH_TYPE[k] || k; }
  function source(k)    { return (SOURCE[k] || { label: k }).label; }

  /* 结果值（记录里的 result 字段）→ 中文 */
  function result(k) {
    const s = String(k || '').toUpperCase();
    if (s === 'PASS')  return '通过';
    if (s === 'FAIL')  return '失败';
    if (s === 'ABORT') return '异常终止';
    return k || '--';
  }
  /* 结果 → CSS pill 类 */
  function resultPill(k) {
    const s = String(k || '').toUpperCase();
    if (s === 'PASS')  return 'p-pass';
    if (s === 'FAIL')  return 'p-fail';
    if (s === 'ABORT') return 'p-abort';
    return 'p-wait';
  }
  /* 盘位状态 → CSS pill 类 */
  function statePill(k) {
    if (k === 'pass')  return 'p-pass';
    if (k === 'fail')  return 'p-fail';
    if (k === 'abort') return 'p-abort';
    if (k === 'testing') return 'p-run';
    return 'p-wait';
  }
  /* 工单状态 → CSS 类 */
  function woPill(k) { return (WO_STATE[k] || {}).cls || 'wo-st-wait'; }

  /* 数据新鲜度 → 文案 + 等级 */
  function fresh(level) {
    return { live: '实时', recent: '较新', today: '今日', stale: '陈旧', none: '无数据' }[level] || level;
  }

  return { slotState, eqState, woState, verdict, matchType, source,
           result, resultPill, statePill, woPill, fresh };
})();
