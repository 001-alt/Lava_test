/* ============================================================================
   工单管理 —— 工序链、计划/实测、结单检查与副作用
   ----------------------------------------------------------------------------
   对应 RDIMM 的 WO_PROJECT_RULES / woStationPlan / woStationActual /
   woCheckClose / releaseLayerForNext。

   工序链规则（可按机型配置）：
     · Lava 系列走完整主线 ICT→FUNCTION→BIST→ESS→FINAL→CUS
     · ORT 是旁路抽检，不在工序链内；单独按 2.5% 计算抽样量
   ============================================================================ */

const WorkOrder = (() => {

  /* 工序链规则：按顺序首个 match 命中者生效，末条兜底 */
  const PROCESS_RULES = [
    { key: 'Lava 全系列', match: /LVA|Lava/i, steps: MAINLINE.slice(), note: '走完整主线，ORT 旁路抽检' },
    { key: '普通（兜底）', match: /[\s\S]*/,   steps: MAINLINE.slice(), note: '走完整主线' }
  ];

  function ruleOf(project) {
    const p = String(project || '');
    for (const r of PROCESS_RULES) {
      try { if (r.match.test(p)) return r; } catch (e) { }
    }
    return PROCESS_RULES[PROCESS_RULES.length - 1];
  }

  /* 计划数：主线各站计划 = 批量；ORT 单独按抽样算 */
  function planOf(project, qty) {
    const rule = ruleOf(project);
    const plan = {};
    rule.steps.forEach(st => { plan[st] = Number(qty || 0); });
    const ort = Sampling.calc(qty);
    if (ort.sample > 0) plan.ORT = ort.sample;
    return plan;
  }

  /* 工序链（含 ORT 作为旁路末段，界面上以虚线区分） */
  function processOf(project) {
    const rule = ruleOf(project);
    return rule.steps.slice();
  }
  function processWithOrt(project) {
    return processOf(project).concat(['ORT']);
  }

  /* --------------------------------------------------------------------------
     实测进度：按记录统计每个工站的 tested/pass/fail
     记录形状须含 { woId, station, result }
     -------------------------------------------------------------------------- */
  function actualOf(wo, records) {
    const out = {};
    (records || []).forEach(r => {
      if (r.woId !== wo.id) return;
      const st = MatchEngine.normalizeStation(null, r.station) || r.station || '未知';
      const b = out[st] = out[st] || { tested: 0, pass: 0, fail: 0, abort: 0 };
      b.tested++;
      const res = String(r.result || '').toUpperCase();
      if (res === 'PASS') b.pass++;
      else if (res === 'FAIL') b.fail++;
      else if (res === 'ABORT') b.abort++;
    });
    return out;
  }

  /* 进度百分比（按主线各站计划完成度取平均） */
  function progressOf(wo, actual) {
    const plan = wo.plan || {};
    const steps = processOf(wo.model || wo.pn);
    if (!steps.length) return 0;
    let sum = 0;
    steps.forEach(st => {
      const need = plan[st] || 0;
      const got = (actual[st] && actual[st].tested) || 0;
      sum += need > 0 ? Math.min(1, got / need) : (got > 0 ? 1 : 0);
    });
    return sum / steps.length;
  }

  /* --------------------------------------------------------------------------
     结单检查：两个条件全部满足才能结单
       1. 每站实测 >= 计划
       2. 无未确认的 FAIL
     -------------------------------------------------------------------------- */
  function checkClose(wo, actual, records) {
    if (!wo) return { ok: false, issues: ['工单不存在'], actual: actual || {}, openFail: 0 };
    actual = actual || {};
    const issues = [];
    const plan = wo.plan || {};
    const steps = processOf(wo.model || wo.pn);

    steps.forEach(st => {
      const need = plan[st] || 0;
      const got = (actual[st] && actual[st].tested) || 0;
      if (got < need) {
        issues.push(`${st} 未完成（已测 ${got} / 计划 ${need}）`);
      }
    });

    // ORT 单独提示（不阻塞结单，因为它是旁路）
    const ortNeed = plan.ORT || 0;
    const ortGot = (actual.ORT && actual.ORT.tested) || 0;
    const ortNote = ortNeed > 0
      ? `ORT 抽样 ${ortGot} / ${ortNeed}（旁路，不阻塞结单）`
      : '';

    const openFail = (records || []).filter(r =>
      r.woId === wo.id && String(r.result || '').toUpperCase() === 'FAIL' && !r.handled);
    if (openFail.length) {
      issues.push(`存在 ${openFail.length} 条未确认的 FAIL`);
    }

    return { ok: issues.length === 0, issues, actual, ortNote, openFail: openFail.length };
  }

  /* --------------------------------------------------------------------------
     结单副作用：把工单涉及的盘位归档后复位
     这是破坏性操作，靠 locked + 反结单保护（沿用 RDIMM 的做法）
     -------------------------------------------------------------------------- */
  function buildArchives(wo, slots) {
    const rel = (slots || []).filter(s => s.woNo === wo.no || (s.woNo === wo.no && s.state !== 'empty'));
    if (!rel.length) return [];
    // 按 工站+机柜+服务器+箱体 聚合
    const groups = {};
    rel.forEach(s => {
      const k = [s.station, s.cabinetId, s.serverId, s.boxId].join('|');
      const g = groups[k] = groups[k] || {
        station: s.station, cabinetId: s.cabinetId, serverId: s.serverId,
        boxId: s.boxId, pn: s.pn, model: s.model, pass: 0, fail: 0, abort: 0
      };
      if (s.state === 'pass') g.pass++;
      else if (s.state === 'fail') g.fail++;
      else if (s.state === 'abort') g.abort++;
    });
    return Object.keys(groups).map(k => Schema.newArchive(Object.assign({
      woId: wo.id, woNo: wo.no, releasedAt: Date.now()
    }, groups[k])));
  }

  /* 复位盘位：清空业务字段，保留物理损伤/维护标记 */
  function resetSlots(slots) {
    const KEEP = { damaged: 1, maintenance: 1, disabled: 1 };
    return (slots || []).map(s => {
      const keep = KEEP[s.state];
      return Object.assign({}, s, {
        state: keep ? s.state : 'empty',
        sn: '', pn: '', model: '', woNo: '', lot: '',
        result: '', errCode: '', verdict: '', confirmed: undefined,
        retestRound: 0, startTime: null, endTime: null, cycleMs: null,
        updatedAt: Date.now()
      });
    });
  }

  /* --------------------------------------------------------------------------
     状态流转
     待生产 →(接单)→ 已接单 →(开始)→ 生产中 →(结单)→ 已结单 →(反结单)→ 生产中
     -------------------------------------------------------------------------- */
  function accept(wo, by) {
    if (wo.status !== 'wait') return { ok: false, msg: '当前状态不可接单' };
    wo.status = 'accepted';
    wo.acceptedBy = by || '';
    wo.acceptedAt = Date.now();
    return { ok: true, msg: '已接单' };
  }
  function start(wo) {
    if (wo.status !== 'accepted' && wo.status !== 'wait') return { ok: false, msg: '当前状态不可开始生产' };
    wo.status = 'running';
    if (!wo.startDate) wo.startDate = Util.todayKey();
    return { ok: true, msg: '已开始生产' };
  }
  function close(wo, by, note) {
    if (wo.status === 'closed') return { ok: false, msg: '该工单已结单' };
    wo.status = 'closed';
    wo.closedBy = by || '';
    wo.closedAt = Date.now();
    wo.closeNote = note || '';
    wo.endDate = Util.todayKey();
    wo.locked = true;
    return { ok: true, msg: '已结单' };
  }
  function reopen(wo) {
    if (wo.status !== 'closed') return { ok: false, msg: '该工单未结单' };
    wo.status = 'running';
    wo.closedBy = ''; wo.closedAt = null; wo.closeNote = '';
    wo.locked = false;
    return { ok: true, msg: '已反结单' };
  }

  /* 新建工单 */
  function create(input) {
    const wo = Schema.newWorkOrder(input);
    wo.process = processOf(wo.model || wo.pn);
    wo.plan = planOf(wo.model || wo.pn, wo.qty);
    return wo;
  }

  function validate(wo, existing) {
    const errs = [];
    if (!wo.no) errs.push('工单号必填');
    if (existing && existing.some(w => w.no === wo.no && w.id !== wo.id)) errs.push('工单号已存在');
    if (!(Number(wo.qty) > 0)) errs.push('生产数量必须大于 0');
    return { ok: errs.length === 0, errors: errs };
  }

  /* 工单汇总（列表页统计卡用） */
  function summary(list) {
    const out = { total: 0, wait: 0, accepted: 0, running: 0, closed: 0, qty: 0 };
    (list || []).forEach(w => {
      out.total++;
      out.qty += Number(w.qty || 0);
      if (out[w.status] != null) out[w.status]++;
    });
    return out;
  }

  return {
    PROCESS_RULES, ruleOf, planOf, processOf, processWithOrt,
    actualOf, progressOf, checkClose,
    buildArchives, resetSlots,
    accept, start, close, reopen, create, validate, summary
  };
})();
