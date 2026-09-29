#!/usr/bin/env node
/* ============================================================================
   领域层测试 —— 纯逻辑，无需浏览器
   运行：node tools/test-domain.js
   ============================================================================ */
'use strict';
const fs = require('fs'), path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const FILES = [
  'core/constants.js', 'core/util.js',
  'store/schema.js',
  'domain/topology.js', 'domain/capacity.js', 'domain/sampling.js',
  'domain/errcode-rules.js', 'domain/defect-engine.js',
  'domain/match-engine.js', 'domain/workorder.js', 'domain/trace.js'
];

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + extra : '')); }
}
function head(t) { console.log('\n' + t); }

/* localStorage / document 桩（部分模块间接依赖） */
const _ls = {};
global.localStorage = {
  getItem: k => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: k => { delete _ls[k]; }
};
global.document = { createElement: () => ({ style: {}, setAttribute() { }, appendChild() { } }) };
global.Toast = undefined;

const src = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
let cfg;

try {
  eval(src + `
cfg = Schema.defaultConfig();
global.__api = { cfg, Topology, Capacity, Sampling, ErrCodeRules, DefectEngine, MatchEngine, WorkOrder, Trace, Schema, Util };
`);
} catch (e) {
  console.log('❌ 模块加载失败：', e.message, '\n', e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}
const A = global.__api;
cfg = A.cfg;

/* ========================================================================== */
head('1. 拓扑');
{
  const topo = A.Topology.all(cfg);
  ok(topo.totalSlots === 13585, '盘位总数 = 13,585（按设备台账实测数）', topo.totalSlots);
  const s = A.Topology.summary(cfg);
  ok(s.length === 7, '工站数 = 7', s.length);
  const EXPECT = { ICT: 1, FUNCTION: 256, BIST: 4864, ESS: 2304, FINAL: 4976, ORT: 528, CUS: 656 };
  let allOk = true;
  s.forEach(x => { if (EXPECT[x.station] !== x.online) { allOk = false; console.log('    ' + x.station + ': ' + x.online); } });
  ok(allOk, '各工站在线容量与真实配置一致');
  const CEXP = { FUNCTION: 2, FINAL: 35, ORT: 4, CUS: 5 };
  let cabOk = true;
  s.forEach(x => { if (CEXP[x.station] != null && CEXP[x.station] !== x.cabCount) cabOk = false; });
  ok(cabOk, '机柜数正确（FUNCTION 2 / FINAL 35 / ORT 4 / CUS 5）');
  const loc = A.Topology.locate(cfg, A.Schema.slotKey('FINAL', 'SRV-N-001', 5));
  ok(loc && loc.cabinetId === 'CAB-N-01', '盘位定位到机柜', loc && loc.label);
  ok(A.Topology.siblings(cfg, A.Schema.slotKey('BIST', 'OVEN-B-01', 7), 'box').length === 256, '同箱追溯 = 256 盘位');
  ok(A.Topology.siblings(cfg, A.Schema.slotKey('FINAL', 'SRV-N-001', 5), 'cabinet').length === 144, '同柜追溯 = 144 盘位（9×16）');
}

/* ========================================================================== */
head('2. 产能与瓶颈');
{
  const ov = A.Capacity.overview(cfg);
  ok(ov.gate && ov.gate.station === 'ICT', '节拍源 = ICT', ov.gate && ov.gate.station);
  ok(Math.round(ov.lineRate) === 3000, '整线节拍 = 3,000 块/天（跟 ICT 走）', Math.round(ov.lineRate));
  const bySt = {};
  ov.rows.forEach(r => bySt[r.station] = Math.round(r.daily));
  ok(bySt.ICT === 3000, 'ICT 有效日产能 3,000（含上下料 28.8 秒/块）', bySt.ICT);
  ok(bySt.BIST === 4169, 'BIST 日产能 4,169（19 箱 × 28h）', bySt.BIST);
  ok(bySt.FINAL === 3852, 'FINAL 日产能 3,852（311 台 × 31h）', bySt.FINAL);
  const adv = A.Capacity.advice(cfg);
  ok(adv.length > 0, '能产出优化建议 ' + adv.length + ' 条');
  ok(adv.some(a => /ICT/.test(a.text) && /单点/.test(a.text)), '建议中包含 ICT 单点风险提示');
}

/* ========================================================================== */
head('3. 良率口径（异常终止不计入分母）');
{
  const y = A.Capacity.yieldOf({ pass: 95, fail: 5, abort: 30 });
  ok(Math.abs(y.pct - 0.95) < 1e-9, 'PASS 95 / FAIL 5 / ABORT 30 → 良率 95%', (y.pct * 100).toFixed(2) + '%');
  ok(y.abort === 30, '异常终止单列，未混入分母');
  ok(A.Capacity.yieldOf({ pass: 0, fail: 0, abort: 5 }).pct === null, '无判定记录时良率为 null（不显示 0%）');
}

/* ========================================================================== */
head('4. ORT 抽样');
{
  const cases = [[100, 3, 1], [500, 13, 1], [1000, 25, 2], [2000, 50, 4], [5000, 125, 8], [10000, 250, 16]];
  let allOk = true;
  cases.forEach(([q, s, r]) => {
    const c = A.Sampling.calc(q);
    if (c.sample !== s || c.rounds !== r) { allOk = false; console.log('    ' + q + ' → 抽' + c.sample + '/台次' + c.rounds + '，期望 ' + s + '/' + r); }
  });
  ok(allOk, '抽样表全部匹配规范 §5.1（100→3/1 … 10000→250/16）');
  const con = A.Sampling.consistency(cfg);
  ok(con.ok, 'ORT 容量自洽性：需求 ' + Math.round(con.demand) + ' vs 能力 ' + Math.round(con.capacity) +
    '（匹配 ' + (con.match * 100).toFixed(1) + '%）');
  ok(Math.abs(con.match - 0.994) < 0.01, 'ORT 供需匹配度 ≈ 99.4%（33 台正好覆盖 2.5% 抽检）');
}

/* ========================================================================== */
head('5. 判定引擎');
{
  A.DefectEngine.ensureRules(cfg);
  ok(cfg.defectRules.length === A.DefectEngine.rules(cfg).length, '规则表初始化 ' + cfg.defectRules.length + ' 条');

  const j1 = A.DefectEngine.classify(cfg, 'test failed', 'E-BIST-407', 'BIST');
  ok(j1.verdict === 'functional', '错误码命中 → 功能性不良', j1.verdict);
  ok(j1.confidence === 'rule', '置信度 rule');

  const j2 = A.DefectEngine.classify(cfg, '机柜 Sel 事件发生', '', 'ESS');
  ok(j2.verdict === 'nonfunctional', '关键词 Sel → 非功能性（不进不良表）', j2.verdict);

  const j3 = A.DefectEngine.classify(cfg, '完全未知的内容 xyz123', '', 'FINAL');
  ok(j3.verdict === 'unknown', '未命中 → 待确认', j3.verdict);
  ok(j3.confidence === 'none', '置信度 none');

  const j4 = A.DefectEngine.classify(cfg, 'anything', '', '');
  ok(j4.verdict === 'unknown', 'any 兜底规则生效');

  // 错误码提取
  ok(A.ErrCodeRules.extract('报错 E-ESS-220 发生') === 'E-ESS-220', '从文本提取错误码 E-ESS-220');
  ok(A.ErrCodeRules.extract('code 0x000B fail') === '0x000B', '提取十六进制错误码 0x000B');
  ok(A.ErrCodeRules.extract('没有错误码') === '', '无错误码时返回空');

  // 处置策略
  ok(A.ErrCodeRules.allowRetest(cfg, 'E-BIST-407') === true, 'E-BIST-407 允许复测');
  ok(A.ErrCodeRules.allowRetest(cfg, 'E-ESS-220') === false, 'E-ESS-220 不允许复测');
  ok(A.ErrCodeRules.lockSn(cfg, 'E-ESS-220') === true, 'E-ESS-220 锁定 SN');
  ok(A.ErrCodeRules.canRetest(cfg, 'E-BIST-407', 1).ok === false, '复测超限被拒');
}

/* ========================================================================== */
head('6. 匹配引擎');
{
  ok(A.MatchEngine.normalizeStation(cfg, '功能测试') === 'FUNCTION', '中文别名 → FUNCTION');
  ok(A.MatchEngine.normalizeStation(cfg, 'FUNC') === 'FUNCTION', '缩写 FUNC → FUNCTION');
  ok(A.MatchEngine.normalizeStation(cfg, 'ess') === 'ESS', '小写 ess → ESS');
  ok(A.MatchEngine.modelOf(cfg, 'LVA-SSD-1T92-B3') === 'Lava 1.92T', 'PN → 机型');
  const fn = A.MatchEngine.fromFilename(cfg, 'FINAL_CAB-N-01_SRV-N-003_20260929_143021.log');
  ok(fn.station === 'FINAL' && fn.cabinetId === 'CAB-N-01' && fn.serverId === 'SRV-N-003',
    '从文件名解出工站/机柜/服务器', JSON.stringify(fn));
  const keys = A.MatchEngine.extractKeys(cfg, 'SN: LVA260929-00001\nStation: FINAL\n温度: 42.5');
  ok(keys['SN'] === 'LVA260929-00001' && keys['工站'] === 'FINAL' && keys['温度'] === '42.5',
    '关键项正则抽取', JSON.stringify(keys));
}

/* ========================================================================== */
head('7. 工单');
{
  const wo = A.WorkOrder.create({ no: 'WO-TEST-001', pn: 'LVA-SSD-1T92-B3', model: 'Lava 1.92T', qty: 1000 });
  ok(wo.process.length === 6, '工序链 6 段（不含 ORT 旁路）', wo.process.join('→'));
  ok(wo.process[0] === 'ICT' && wo.process[5] === 'CUS', '工序链顺序 ICT→…→CUS');
  ok(wo.plan.ICT === 1000 && wo.plan.CUS === 1000, '主线各站计划数 = 批量');
  ok(wo.plan.ORT === 25, 'ORT 计划 = 抽样数 25', wo.plan.ORT);

  ok(A.WorkOrder.accept(wo, '张三').ok, '接单');
  ok(wo.status === 'accepted', '状态 → 已接单');
  ok(A.WorkOrder.start(wo).ok && wo.status === 'running', '开始生产 → 生产中');

  // 未完成不可结单
  const recs = [{ woId: wo.id, station: 'ICT', result: 'PASS', handled: true }];
  const act = A.WorkOrder.actualOf(wo, recs);
  const chk = A.WorkOrder.checkClose(wo, act, recs);
  ok(!chk.ok, '未完成时拒绝结单');
  ok(chk.issues.some(i => /未完成/.test(i)), '给出未完成原因');

  // 未确认 FAIL 不可结单
  const wo2 = A.WorkOrder.create({ no: 'WO-TEST-002', pn: 'X', qty: 10 });
  const recs2 = wo2.process.map(st => ({ woId: wo2.id, station: st, result: 'PASS', handled: true }));
  recs2.push({ woId: wo2.id, station: 'FINAL', result: 'FAIL', handled: false });
  const chk2 = A.WorkOrder.checkClose(wo2, A.WorkOrder.actualOf(wo2, recs2), recs2);
  ok(!chk2.ok && chk2.issues.some(i => /未确认的 FAIL/.test(i)), '存在未确认 FAIL 时拒绝结单');

  // 完成且无未确认 FAIL 才可结单
  // 注意：计划数 = 批量（10），因此每站要造够 10 条记录才算完成
  const recs3 = [];
  wo2.process.forEach(st => {
    for (let i = 0; i < wo2.qty; i++) {
      recs3.push({ woId: wo2.id, station: st, result: 'PASS', handled: true });
    }
  });
  const chk3 = A.WorkOrder.checkClose(wo2, A.WorkOrder.actualOf(wo2, recs3), recs3);
  ok(chk3.ok, '全部完成且无未确认 FAIL → 允许结单');
  ok(chk3.ortNote.indexOf('旁路') >= 0, 'ORT 标注为旁路，不阻塞结单');

  // 结单副作用
  const slots = [
    { station: 'FINAL', cabinetId: 'CAB-N-01', serverId: 'SRV-N-001', boxId: '', pn: 'X', model: 'M', woNo: 'WO-TEST-002', state: 'pass' },
    { station: 'FINAL', cabinetId: 'CAB-N-01', serverId: 'SRV-N-001', boxId: '', pn: 'X', model: 'M', woNo: 'WO-TEST-002', state: 'fail' },
    { station: 'FINAL', cabinetId: 'CAB-N-01', serverId: 'SRV-N-001', boxId: '', pn: 'X', model: 'M', woNo: 'WO-TEST-002', state: 'damaged' }
  ];
  const arcs = A.WorkOrder.buildArchives(wo2, slots);
  ok(arcs.length === 1 && arcs[0].pass === 1 && arcs[0].fail === 1, '结单归档统计正确');
  const reset = A.WorkOrder.resetSlots(slots);
  ok(reset[0].state === 'empty' && reset[0].sn === '', '复位清空业务字段');
  ok(reset[2].state === 'damaged', '复位保留损坏标记（不误清物理状态）');

  ok(A.WorkOrder.close(wo2, '李四', '完成').ok && wo2.locked, '结单并加锁');
  ok(A.WorkOrder.reopen(wo2).ok && !wo2.locked, '反结单解锁');
}

/* ========================================================================== */
head('8. 追溯');
{
  const recs = [
    { sn: 'S1', station: 'ICT', result: 'PASS', time: 1000, pn: 'P', woNo: 'W1', cabinetId: '', boxId: '' },
    { sn: 'S1', station: 'FUNCTION', result: 'PASS', time: 2000, pn: 'P', woNo: 'W1', cabinetId: 'CAB-F-01', boxId: '' },
    { sn: 'S1', station: 'FUNCTION', result: 'FAIL', time: 3000, pn: 'P', woNo: 'W1', cabinetId: 'CAB-F-01', boxId: '' },
    { sn: 'S1', station: 'BIST', result: 'PASS', time: 4000, pn: 'P', woNo: 'W1', cabinetId: '', boxId: 'OVEN-B-01' }
  ];
  const t = A.Trace.bySn('S1', recs);
  ok(t.chain.length === 7, '流转链含 7 段（6 主线 + ORT）', t.chain.length);
  ok(t.chain[0].station === 'ICT' && t.chain[0].state === 'pass', 'ICT 段判定为 pass');
  const fn = t.chain.filter(c => c.station === 'FUNCTION')[0];
  ok(fn.state === 'fail' && fn.retest === 1, 'FUNCTION 取最后一条结果，复测次数 1', fn.state + '/' + fn.retest);
  ok(t.chain.filter(c => c.station === 'ESS')[0].state === 'pending', '未到的工站标 pending');
  ok(t.hasFail === true, '标记存在 FAIL');

  const ortSeg = t.chain.filter(c => c.station === 'ORT')[0];
  ok(ortSeg.bypass === true, 'ORT 标注为旁路');

  const box = A.Trace.byBox('OVEN-B-01',
    recs,
    [{ boxId: 'OVEN-B-01', state: 'pass', sn: 'S1', station: 'BIST' },
     { boxId: 'OVEN-B-01', state: 'fail', sn: 'S2', station: 'BIST' }]);
  ok(box.slotCount === 2 && box.counts.fail === 1, '同箱追溯统计正确');
  ok(/同受该箱体工况影响/.test(box.impact), '给出连带影响面说明');

  const q = A.Trace.search('S1', { records: recs, bad: [], error: [], slots: [] });
  ok(q && q.records.length === 4, '通用检索命中 4 条记录');
  ok(q.timeline.length === 4, '时间线合并 4 条');
  ok(q.timeline[0].time === 4000, '时间线按时间倒序');
}

/* ========================================================================== */
console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(60) + '\n');
process.exit(fail ? 1 : 0);
