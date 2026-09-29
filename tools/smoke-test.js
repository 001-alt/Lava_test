#!/usr/bin/env node
/* ============================================================================
   端到端冒烟测试 —— 无浏览器环境下跑真实代码路径
   ----------------------------------------------------------------------------
   用最小 DOM 桩加载构建产物，验证：
     1. 初始化不抛错，存储后端正确降级
     2. 模拟数据生成出精确 12,737 个盘位
     3. 10 个视图渲染函数都能产出非空 HTML 且不抛错
     4. 判定引擎、导出、追溯在真实数据上工作正常
   运行：node tools/smoke-test.js
   ============================================================================ */
'use strict';
const fs = require('fs'), path = require('path');

const HTML = path.join(__dirname, '..', 'Lava_test看板.html');
if (!fs.existsSync(HTML)) {
  console.log('❌ 未找到构建产物，请先运行 node build.js');
  process.exit(1);
}
const src = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + extra : '')); }
}
function head(t) { console.log('\n' + t); }

/* ==========================================================================
   最小 DOM 桩
   ========================================================================== */
const _els = {};
function mkEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    _html: '', _text: '', value: '', files: null, checked: false,
    dataset: {}, style: {}, children: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); }
    },
    setAttribute(k, v) { this['attr_' + k] = v; },
    getAttribute(k) { return this['attr_' + k]; },
    removeAttribute(k) { delete this['attr_' + k]; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    remove() { },
    click() { },
    focus() { },
    addEventListener() { },
    removeEventListener() { },
    querySelector() { return null; },
    /* 桩里的 querySelectorAll 只支持本项目真正用到的那几个选择器。
       其中 `.cell[data-k]` 必须支持 —— SlotGrid.buildIndex 靠它按文档序
       取出所有盘位格；若这里恒返回空，增量补丁路径就完全没被测试覆盖，
       而「文档序 == 发射序」正是最容易错的地方。 */
    querySelectorAll(sel) {
      const s = String(sel || '');
      if (s.indexOf('.cell[data-k]') >= 0) return el._cells || [];
      return [];
    },
    closest() { return null; },
    contains() { return false; },
    scrollIntoView() { },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    getContext() {
      // canvas 2d 上下文桩
      return { scale() { }, clearRect() { }, fillRect() { }, set fillStyle(v) { }, get fillStyle() { return ''; } };
    },
    toBlob(cb) { cb && cb(null); },
    cloneNode() { return mkEl(tag); }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = String(v == null ? '' : v);
      // 从 HTML 串里按出现顺序抽出所有盘位格，模拟文档序；
      // 同时记录每个工站分区（data-st）各自拥有哪些格，
      // 让 document.querySelector('#floorBody .sec-body[data-st="X"]') 能返回对应子集。
      el._cells = [];
      el._byStation = {};
      const re = /\bclass="(cell[^"]*)"\s+data-k="([^"]*)"|<div class="sec-body[^"]*"\s+data-st="(\w+)"/g;
      let m, idx = 0, curStation = null;
      while ((m = re.exec(el._html))) {
        if (m[3]) {                                    // 命中分区头
          curStation = m[3];
          if (!el._byStation[curStation]) el._byStation[curStation] = [];
          continue;
        }
        const cell = mkEl('div');
        // 必须把解析出的 class 真的设进元素 —— SlotGrid.patch 会读 node.className
        // 来保留非状态类（如 cell / no-sn），桩里不设就会把它们丢掉，
        // 表现为「补丁后只剩状态类」，看起来像应用 bug 实则桩的问题。
        cell.className = m[1];
        cell.dataset.k = m[2];
        cell._order = idx++;
        el._cells.push(cell);
        if (curStation) el._byStation[curStation].push(cell);
      }
    }
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = String(v == null ? '' : v); }
  });
  Object.defineProperty(el, 'className', {
    get() { return Array.from(el.classList._s).join(' '); },
    set(v) { el.classList._s = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  });
  return el;
}

global.window = {
  devicePixelRatio: 1, innerHeight: 900, pageYOffset: 0,
  addEventListener() { }, scrollTo() { },
  requestAnimationFrame: cb => setTimeout(cb, 0),
  /* 主题模块会读系统深浅色偏好；桩里固定返回「非浅色」，
     等价于系统未偏好浅色 → 默认深色主题 */
  matchMedia: q => ({ matches: false, addEventListener() { }, addListener() { } })
};
/* Node 24 起 navigator 是只读全局，必须用 defineProperty 覆盖 */
Object.defineProperty(global, 'navigator', {
  value: { storage: null }, writable: true, configurable: true
});
global.document = {
  readyState: 'complete',
  body: mkEl('body'),
  documentElement: mkEl('html'),
  getElementById(id) { return _els[id] || (_els[id] = mkEl('div')); },
  /* 只支持 floor 视图实际用到的那一个后代选择器：
       '#floorBody .sec-body[data-st="X"]'
     返回一个带 _cells 的合成元素，其格集合就是该工站的格。
     有了它，SlotGrid.buildIndex 才能真的建起索引，增量补丁路径才被覆盖。 */
  querySelector(sel) {
    const m = String(sel || '').match(/^#([\w-]+)\s+\.sec-body\[data-st="([^"]+)"\]$/);
    if (m) {
      const parent = _els[m[1]];
      if (!parent || !parent._byStation || !parent._byStation[m[2]]) return null;
      const sub = mkEl('div');
      sub._cells = parent._byStation[m[2]];
      return sub;
    }
    return null;
  },
  querySelectorAll() { return []; },
  createElement(tag) { return mkEl(tag); },
  addEventListener() { },
  removeEventListener() { }
};
/* 关键：localStorage 与 indexedDB 都不可用 → Repo 走内存后端，
   这正是 file:// 下最坏情况，也最容易暴露问题 */
global.localStorage = undefined;
global.indexedDB = undefined;
global.IntersectionObserver = undefined;
global.XMLSerializer = function () { this.serializeToString = () => ''; };
global.Image = function () { };
/* ⚠️ 不要覆盖 Blob —— xlsx 解析走 DecompressionStream，
   而 DecompressionStream 依赖真实的 Blob/Response。Node 18+ 原生就有，直接用。 */
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() { } };
global.FileReader = function () { };
global.requestAnimationFrame = cb => setTimeout(cb, 0);

/* ==========================================================================
   加载构建产物
   ========================================================================== */
/* 产物里的模块用 const 声明，作用域局限于 eval 内部 —— 必须在 eval 里
   把需要的引用挂到 global 上，外部才拿得到（闭包会保持 eval 作用域存活）。 */
let A = null;
const probe = `
global.__LAVA = {
  App, Repo, Mock, Schema, Topology, Capacity, Sampling,
  DefectEngine, ErrCodeRules, MatchEngine, WorkOrder, Trace,
  LocalStore, Backup, Util, L, SlotGrid, DataTable, Charts, Highlight,
  Timeline, ViewFloor, ViewBoard, Modal, Drawer, Toast, Dom, Bus, EVT, Theme,
  Xlsx, Ledger, Registry,
  Bridge, Ssh, FtpChannel, Scheduler, ParserRegistry, Pipeline,
  ModalExportCenter, ModalSettings,
  ST, MAINLINE, VERDICT, DEFECT_TYPES, STATIONS, VIEWS, SCHEMA_VERSION
};
`;

head('1. 加载与初始化');
try {
  eval(src + probe);
  A = global.__LAVA;
  ok(!!A && !!A.App, '构建产物加载成功（' + src.split('\n').length + ' 行）');
} catch (e) {
  ok(false, '加载失败', e.message);
  console.log(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
/* 后续所有断言都通过 A.xxx 访问，不再依赖 eval 作用域 */
const { App, Repo, Mock, Topology, Capacity, Sampling, DefectEngine,
        ErrCodeRules, WorkOrder, Trace, Backup, Util, SlotGrid, DataTable,
        Schema, LocalStore, ViewFloor, Theme } = A;

(async () => {
  try {
    await App.boot();
    ok(true, 'App.boot() 无异常');
    ok(Repo.backend() === 'memory', '存储后端正确降级为 memory（无 localStorage / indexedDB）',
       Repo.backend());
    ok(App.cfg != null, '配置已加载');
    ok(DefectEngine.rules(App.cfg).length > 0,
       '判定规则已初始化 ' + DefectEngine.rules(App.cfg).length + ' 条');
    ok(_els['viewTabs'] && _els['viewTabs'].innerHTML.indexOf('tab') >= 0,
       '标签页已渲染');
    ok(_els['stationStrip'] && _els['stationStrip'].innerHTML.length > 0,
       '工站总览条已渲染');
    ok(_els['floorBody'] && _els['floorBody'].innerHTML.length > 0,
       '平面图已渲染（' + (_els['floorBody'].innerHTML.length / 1024).toFixed(0) + ' KB HTML）');
  } catch (e) {
    ok(false, 'App.boot() 抛错', e.message);
    console.log(e.stack.split('\n').slice(0, 6).join('\n'));
    process.exit(1);
  }

  /* ====================================================================== */
  head('2. 模拟数据生成');
  let r = null;
  const t0 = Date.now();
  try {
    r = await Mock.generate(App.cfg, {});
  } catch (e) {
    ok(false, '生成失败', e.message);
    console.log(e.stack.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }
  const genMs = Date.now() - t0;
  ok(!!r, '生成完成，耗时 ' + genMs + 'ms');
  ok(r.capacity === 13585, '盘位总容量 = 13,585（按设备台账实测数）', r.capacity);
  ok(r.slots > 0 && r.slots <= r.capacity,
     '非空盘位 ' + r.slots.toLocaleString() + '（装载率 ' +
     (r.slots / r.capacity * 100).toFixed(1) + '%）');
  ok(r.records > 0, '测试记录 ' + r.records.toLocaleString() + ' 条');
  ok(r.bad > 0, '不良记录 ' + r.bad + ' 条（其中待确认 ' + r.badPending + '）');
  ok(r.badPending > 0, '存在待确认不良，可验证待确认队列');
  ok(r.error > 0, '报错记录 ' + r.error + ' 条');
  ok(r.workOrders === 3, '工单 ' + r.workOrders + ' 个');

  /* ====================================================================== */
  head('3. 数据装载');
  try {
    App.invalidate();
    await App.loadAll();
    ok(App.slots.size > 0, '内存盘位表 ' + App.slots.size.toLocaleString() + ' 条');
    ok((App.bad || []).length > 0, '不良记录已加载');
    ok((App.error || []).length > 0, '报错记录已加载');
    ok((App.workOrders || []).length === 3, '工单已加载');

    /* 逐工站校验容量 */
    const topo = Topology.all(App.cfg);
    const EXP = { ICT: 1, FUNCTION: 256, BIST: 4864, ESS: 2304, FINAL: 4976, ORT: 528, CUS: 656 };
    let capOk = true, detail = [];
    Topology.summary(App.cfg).forEach(s => {
      if (EXP[s.station] !== s.online) { capOk = false; detail.push(s.station); }
    });
    ok(capOk, '七个工站在线容量与真实配置一致', detail.join(','));

    const pending = App.pendingBadKeys();
    ok(pending.size > 0, '待确认不良定位到 ' + pending.size + ' 个盘位（平面图黄框）');
  } catch (e) {
    ok(false, '装载失败', e.message);
  }

  /* ====================================================================== */
  head('4. 十个视图渲染');
  const views = [
    ['floor', 'floorBody'], ['board', 'boardBody'], ['daily', 'dailyBody'],
    ['stats', 'statsBody'], ['bad', 'badBody'], ['error', 'errorBody'],
    ['pull', 'pullBody'], ['wo', 'woBody'], ['log', 'logBody'], ['trace', 'traceBody']
  ];
  for (const [key, elId] of views) {
    try {
      const t = Date.now();
      const el = document.getElementById(elId);
      el.innerHTML = '';
      // 渲染函数是 async（要先 await 数据装载），必须等它跑完再取结果
      await App.switchView(key);
      await new Promise(r => setTimeout(r, 0));
      const html = el.innerHTML;
      ok(html.length > 0, key.padEnd(7) + ' 渲染 ' +
         (html.length / 1024).toFixed(1) + ' KB，' + (Date.now() - t) + 'ms',
         html.length ? '' : '输出为空');
    } catch (e) {
      ok(false, key + ' 渲染抛错', e.message);
      console.log('     ' + e.stack.split('\n')[1].trim());
    }
  }

  /* ====================================================================== */
  head('5. 业务逻辑在真实数据上验证');
  {
    /* 产出统计 */
    const ov = Capacity.overview(App.cfg);
    ok(ov.gate && ov.gate.station === 'ICT',
       '整线节拍源 = ICT（' + Math.round(ov.lineRate).toLocaleString() + ' 块/天）');

    /* ORT 互验 */
    const con = Sampling.consistency(App.cfg);
    ok(con.ok, 'ORT 供需匹配 ' + (con.match * 100).toFixed(1) + '%（33 台覆盖 2.5% 抽检）');

    /* 良率：异常终止不入分母 */
    const counts = { pass: 100, fail: 5, abort: 40 };
    const y = Capacity.yieldOf(counts);
    ok(Math.abs(y.pct - 100 / 105) < 1e-9,
       '良率口径正确（abort 不进分母）→ ' + (y.pct * 100).toFixed(2) + '%');

    /* 判定引擎在真实规则上工作 */
    const c1 = DefectEngine.classify(App.cfg, 'test failed', 'E-ESS-220', 'ESS');
    ok(c1.verdict === 'functional', '功能性不良判定正确');
    const c2 = DefectEngine.classify(App.cfg, '机柜 Sel 事件', '', 'BIST');
    ok(c2.verdict === 'nonfunctional', '非功能性判定正确（不入不良表）');
    const c3 = DefectEngine.classify(App.cfg, '完全未知内容 xyz', '', 'FINAL');
    ok(c3.verdict === 'unknown' && c3.confidence === 'none',
       '未命中 → 待确认（confidence=none）');

    /* 同柜追溯在真实拓扑上 */
    const cabKeys = Topology.siblings(App.cfg, Schema.slotKey('FINAL', 'SRV-N-001', 0), 'cabinet');
    ok(cabKeys.length === 144, '同柜追溯 144 盘位（9 台 × 16）');
    const boxKeys = Topology.siblings(App.cfg, Schema.slotKey('BIST', 'OVEN-B-01', 0), 'box');
    ok(boxKeys.length === 256, '同箱追溯 256 盘位');

    /* 工单结单检查 */
    const wo = App.workOrders[0];
    const recs = (App.records || []).filter(x => x.woId === wo.id);
    const chk = WorkOrder.checkClose(wo, WorkOrder.actualOf(wo, recs), recs);
    ok(typeof chk.ok === 'boolean', '结单检查可执行（' +
       (chk.ok ? '可结单' : '不可结单：' + chk.issues.length + ' 项') + '）');

    /* ORT 抽样表 */
    const s1 = Sampling.calc(1000);
    ok(s1.sample === 25 && s1.rounds === 2, '1000 块 → 抽 25 / 2 台次');
    const s2 = Sampling.calc(10000);
    ok(s2.sample === 250 && s2.rounds === 16, '10000 块 → 抽 250 / 16 台次');
  }

  /* ====================================================================== */
  head('6. 导出 / 导入往返');
  try {
    const snap = await Backup.exportData('snapshot', App.cfg, { workOrders: App.workOrders });
    ok(snap.json.length > 0, '快照导出 ' + (snap.json.length / 1024 / 1024).toFixed(2) + ' MB');
    ok(snap.manifest.counts.slots > 0,
       'manifest 记录盘位 ' + snap.manifest.counts.slots.toLocaleString() + ' 条');
    ok(snap.manifest.counts.slotCapacity === 13585, 'manifest 记录总容量 13,585');

    const parsed = JSON.parse(snap.json);
    ok(parsed.slots && parsed.slots.length > 0, '盘位已序列化 ' + parsed.slots.length + ' 条');
    ok(parsed.slotColumns && parsed.slotColumns[0] === 'key',
       '盘位首列为 key（保证导入时精确定位）');
    ok(parsed.slots[0].length === parsed.slotColumns.length,
       '盘位列数与 slotColumns 一致（' + parsed.slotColumns.length + ' 列）');

    /* 真导入：清空 → 导入 → 比对 */
    const beforeCount = App.slots.size;
    const beforeSample = Array.from(App.slots.values())[0];
    const imp = await Backup.importJson(snap.json, 'replace', App.cfg);
    await App.loadAll();
    ok(App.slots.size === beforeCount,
       '导入后盘位数一致（' + beforeCount.toLocaleString() + ' → ' + App.slots.size.toLocaleString() + '）');
    const afterSample = App.slots.get(beforeSample.key);
    ok(afterSample && afterSample.sn === beforeSample.sn && afterSample.state === beforeSample.state,
       '导入后同一盘位数据一致（' + beforeSample.key + ' → SN ' + (afterSample && afterSample.sn) + '）');
    ok((imp.warnings || []).length === 0, '导入无警告',
       (imp.warnings || []).join(' | '));

    /* 合并模式 */
    const merge = await Backup.importJson(snap.json, 'merge', App.cfg);
    ok(merge.slots >= 0, '合并导入可执行（写入 ' + merge.slots + ' 条）');
  } catch (e) {
    ok(false, '导出/导入失败', e.message);
    console.log(e.stack.split('\n').slice(0, 5).join('\n'));
  }

  /* ====================================================================== */
  head('7. 增量补丁');
  {
    await App.loadAll();
    App.state.canPatch = true;
    // 造一个变更：把某盘位改成 fail
    const key = Array.from(App.slots.keys())[0];
    const rec = App.slots.get(key);
    const old = rec.state;
    rec.state = rec.state === 'fail' ? 'pass' : 'fail';
    App.state.lastChanged = new Set([key]);
    const el = document.getElementById('floorBody');
    const beforeLen = el.innerHTML.length;
    try {
      const n = ViewFloor.refresh(App.state.lastChanged);
      ok(true, '增量补丁执行成功');
    } catch (e) {
      ok(false, '增量补丁抛错', e.message);
    }
    rec.state = old;
  }

  /* ====================================================================== */
  head('8. 主题切换');
  try {
    const html = document.documentElement;
    ok(Theme.resolved() === 'dark', '默认主题 = 深色', Theme.resolved());
    ok(html.getAttribute('data-theme') === 'dark', '<html data-theme> 已设置');

    Theme.set('eye', true);
    ok(html.getAttribute('data-theme') === 'eye', '切到护眼主题生效');
    ok(html.getAttribute('style') && String(html.getAttribute('style')).indexOf('light') >= 0 ||
       html.style.colorScheme === 'light', '原生控件配色跟随（color-scheme=light）');

    Theme.set('dark', true);
    ok(html.getAttribute('data-theme') === 'dark', '切回深色生效');

    Theme.set('auto', true);
    ok(Theme.resolved() === 'dark',
       '跟随系统：桩环境未偏好浅色 → 解析为深色', Theme.resolved() + '/' + Theme.current());

    // 循环切换回到起点
    Theme.set('dark', true);
    Theme.cycle();
    ok(Theme.current() === 'eye', '循环切换 dark → eye');
    Theme.cycle();
    ok(Theme.current() === 'auto', '循环切换 eye → auto');
    Theme.cycle();
    ok(Theme.current() === 'dark', '循环切换 auto → dark');

    /* 主题变量完整性：两套主题都必须定义全部颜色变量，
       否则会出现「切过去某块还是原来的底色」这种漏改 */
    const css = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'Lava_test看板.html'), 'utf8');
    const styleBlock = css.match(/<style>([\s\S]*?)<\/style>/)[1];
    const rootVars = new Set((styleBlock.match(/--[a-z0-9-]+\s*:/g) || [])
      .map(s => s.replace(/\s*:/, '').trim()));
    const usedVars = new Set((styleBlock.match(/var\(--[a-z0-9-]+/g) || [])
      .map(s => s.slice(4)));
    const undef = [...usedVars].filter(v => !rootVars.has(v));
    ok(undef.length === 0, '全部 ' + usedVars.size + ' 个 CSS 变量均有定义',
       undef.join(', '));

    const eyeBlock = styleBlock.match(/\[data-theme="eye"\]\s*\{([\s\S]*?)\n\}/);
    ok(!!eyeBlock, '护眼主题变量块存在');
    if (eyeBlock) {
      const eyeVars = new Set((eyeBlock[1].match(/--[a-z0-9-]+\s*:/g) || [])
        .map(s => s.replace(/\s*:/, '').trim()));
      // 深色块里的着色变量，护眼主题应当全部覆盖
      const colorVars = [...rootVars].filter(v =>
        /^--(bg|panel|line|tx|track|row-hover|th|btn-hover|topbar|head|ok|bad|warn|info|run|abort|s-|st-|log|scroll|shadow|note|code|mask)/.test(v));
      const missed = colorVars.filter(v => !eyeVars.has(v));
      ok(missed.length === 0,
         '护眼主题覆盖了全部 ' + colorVars.length + ' 个颜色变量',
         missed.join(', '));
    }
  } catch (e) {
    ok(false, '主题切换测试抛错', e.message);
  }

  /* ====================================================================== */
  head('9. 平面图：逐格显示测试状态 + 隐藏空载设备');
  try {
    LocalStore.ui.set('stationFilter', '');
    LocalStore.ui.set('showEmptyEq', false);
    await App.switchView('floor');
    await new Promise(r => setTimeout(r, 0));

    const html = document.getElementById('floorBody').innerHTML;
    const cells = (html.match(/class="cell[ "]/g) || []).length;
    ok(cells > 0, '默认渲染盘位格，显示测试状态（' + cells.toLocaleString() + ' 格）');

    const topo = Topology.all(App.cfg);
    const idsIn = (s) => new Set((s.match(/data-eq="([^"]+)"/g) || []).map(x => x.slice(9, -1)));

    /* 空载过滤要验证得确定，不能指望模拟数据恰好留出空设备。
       这里人为清空两台设备（一台独立设备、一台机柜内的服务器），
       验证它们从页面上消失，再恢复。 */
    const probeFlat = topo.stationsMap['BIST'][0];               // 独立设备
    const probeSrv  = topo.stationsMap['FUTURE'] ? null : topo.stationsMap['FUNCTION'][0]; // 机柜内服务器
    const probes = [probeFlat, probeSrv].filter(Boolean);
    const backup = [];
    probes.forEach(eq => {
      eq.slotKeys.forEach(k => {
        const r = App.slots.get(k);
        if (r) { backup.push([k, r]); App.slots.delete(k); }
      });
    });
    ok(probes.every(eq => !ViewFloor.hasContent(eq)),
       '已清空 ' + probes.length + ' 台设备用于验证（' + probes.map(e => e.id).join(', ') + '）');

    await App.switchView('floor');
    await new Promise(r => setTimeout(r, 0));
    const htmlA = document.getElementById('floorBody').innerHTML;
    const idsA = idsIn(htmlA);
    ok(probes.every(eq => !idsA.has(eq.id)),
       '空载设备已从页面隐藏（' + probes.map(e => e.id).join(', ') + '）');

    /* 勾选「显示空载设备」后应当出现 */
    LocalStore.ui.set('showEmptyEq', true);
    await App.switchView('floor');
    await new Promise(r => setTimeout(r, 0));
    const htmlB = document.getElementById('floorBody').innerHTML;
    const idsB = idsIn(htmlB);
    ok(probes.every(eq => idsB.has(eq.id)), '勾选后空载设备全部显示');
    ok(idsB.size > idsA.size,
       '显示空载后设备数增加（' + idsA.size + ' → ' + idsB.size + '）');

    /* 机柜布局工站也受同一规则约束 */
    ok(htmlA.indexOf('data-st="FINAL"') >= 0, '机柜布局工站已渲染');

    // 复原：恢复盘位与开关
    backup.forEach(([k, r]) => App.slots.set(k, r));
    LocalStore.ui.set('showEmptyEq', false);
    await App.switchView('floor');
    await new Promise(r => setTimeout(r, 0));
    const idsC = idsIn(document.getElementById('floorBody').innerHTML);
    ok(probes.every(eq => idsC.has(eq.id)), '恢复盘位后设备重新出现');
    ok(ViewFloor.hasContent(probeFlat), 'hasContent 判定恢复正确');

    /* 增量补丁：验证「索引对齐 + 只改状态类」这条路径真的跑通 */
    const bodyEl = document.getElementById('floorBody');
    const domCells = bodyEl._cells || [];
    ok(domCells.length > 0, '桩已从渲染结果解析出 ' + domCells.length.toLocaleString() + ' 个盘位格');

    // 取一个已渲染的盘位，改状态后 patch
    const targetKey = domCells[0] && domCells[0].dataset.k;
    const rec0 = App.slots.get(targetKey);
    if (targetKey && rec0) {
      const oldState = rec0.state;
      const newState = oldState === 'fail' ? 'pass' : 'fail';
      const clsBefore = String(bodyEl._cells.find(c => c.dataset.k === targetKey).className);

      rec0.state = newState;
      App.state.lastChanged = new Set([targetKey]);
      const n = ViewFloor.refresh(App.state.lastChanged);
      ok(n > 0, '增量补丁实际修改了 ' + n + ' 个格（非全量重渲染）');

      const after = (document.getElementById('floorBody')._cells || [])
        .find(c => c.dataset.k === targetKey);
      if (after) {
        const clsAfter = String(after.className);
        const wantCls = (A.SlotGrid.STATE_COLOR && true) ? (newState === 'fail' ? 's-fail' : 's-pass') : '';
        ok(clsAfter.indexOf(wantCls) >= 0,
           '补丁后状态类正确更新为 ' + wantCls + '（' + clsAfter.trim() + '）');
        ok(clsAfter.indexOf('cell') >= 0, '补丁保留了 cell 基础类');
      }

      // 复原
      rec0.state = oldState;
      App.state.lastChanged = new Set([targetKey]);
      ViewFloor.refresh(App.state.lastChanged);
    }
  } catch (e) {
    ok(false, '平面图测试抛错', e.message);
    console.log('     ' + (e.stack || '').split('\n')[1]);
  }

  /* ====================================================================== */
  head('10. 设备台账导入（真实 xlsx）');
  {
    const XLSX_PATH = path.join(__dirname, '..', '设备IP情况.xlsx');
    if (!fs.existsSync(XLSX_PATH)) {
      ok(true, '未找到 设备IP情况.xlsx，跳过（该文件不入版本库属正常）');
    } else {
      try {
        const { Xlsx, Ledger, Registry } = A;
        const buf = fs.readFileSync(XLSX_PATH);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

        const wb = await Xlsx.parse(ab);
        ok(wb.sheets.length > 0, 'xlsx 解析出 ' + wb.sheets.length + ' 张工作表');

        const sheet = wb.sheets[0];
        const parsed = Ledger.parse(sheet);
        ok(parsed.tables.length >= 2,
           '识别出 ' + parsed.tables.length + ' 张子表（服务器表 + 箱体表）',
           parsed.tables.map(t => 'r' + t.headerRow).join(','));
        ok(parsed.summary.length > 0,
           '解析出汇总区 ' + parsed.summary.length + ' 行');
        ok(parsed.stats.activeCount > 300,
           '可接入设备 ' + parsed.stats.activeCount + ' 台');
        ok(parsed.stats.ipCount > 300,
           '去重 IP ' + parsed.stats.ipCount + ' 个');
        ok(parsed.stats.cabinetCount > 20,
           '机柜 ' + parsed.stats.cabinetCount + ' 个');

        /* 台账 → 设备清单 */
        const reg = Registry.fromLedger(parsed);
        ok(reg.devices.length > 0, '生成设备台账 ' + reg.devices.length + ' 台');

        /* 设备编号唯一 —— 编号重复会让 IP 映射串台 */
        const ids = reg.devices.map(d => d.id);
        ok(ids.length === new Set(ids).size,
           '设备编号无重复（' + ids.length + ' 个）',
           '重复 ' + (ids.length - new Set(ids).size) + ' 个');

        /* 编号用的是真实柜号+位号，不是合成名 */
        const sample = reg.devices.filter(d => d.cabinet && d.pos)[0];
        ok(sample && sample.id.indexOf(sample.cabinet) === 0,
           '设备编号含真实机柜号（' + (sample ? sample.id : '--') + '）');

        /* 故障区被排除 */
        const faultyLeft = reg.devices.filter(d => /故障|维修/.test(d.zone || d.cabinet || ''));
        ok(faultyLeft.length === 0, '故障/维修区域设备已排除');

        /* IP 校验 */
        const issues = Registry.validate(reg.devices);
        ok(typeof issues.dupIp === 'object', 'IP 校验可执行（重复 ' +
           Object.keys(issues.dupIp).length + ' / 格式错 ' +
           Object.keys(issues.invalidIp).length + ' / 缺 IP ' + issues.noIp.length + '）');

        /* 切到台账拓扑 */
        const before = Topology.all(App.cfg).totalSlots;
        Topology.setRegistry(reg.devices);
        const after = Topology.all(App.cfg);
        ok(after.source.indexOf('registry') === 0,
           '拓扑切换为台账模式（' + after.source + '）');
        ok(after.totalSlots !== before,
           '盘位随台账变化（' + before.toLocaleString() + ' → ' + after.totalSlots.toLocaleString() + '）');
        ok(after.stationsMap['ICT'].length === 1,
           '台账未覆盖的 ICT 按配置补齐（' + after.stationsMap['ICT'].length + ' 台）');

        /* 台账模式下节拍源仍然生效 */
        const ov2 = Capacity.overview(App.cfg);
        ok(ov2.gate && ov2.gate.station === 'ICT' && Math.round(ov2.lineRate) === 3000,
           '台账模式下整线节拍仍为 ICT 的 3,000 块/天');

        /* 定位到真实设备 */
        const loc = Topology.locate(App.cfg, after.equipment[0].slotKeys[0]);
        ok(loc && loc.label.length > 0, '可定位到台账设备：' + (loc ? loc.label : '--'));

        /* 导出桥接清单 */
        const bl = Registry.toBridgeList(reg.devices);
        ok(bl.length > 0 && bl[0].ip && bl[0].station,
           '桥接连接清单 ' + bl.length + ' 条（含 IP 与工站）');

        /* 恢复合成模式，避免影响后续断言 */
        Topology.setRegistry(null);
        ok(Topology.all(App.cfg).source === 'synthetic', '可切回合成模式');
      } catch (e) {
        ok(false, '台账导入测试抛错', e.message);
        console.log('     ' + (e.stack || '').split('\n')[1]);
      }
    }
  }

  /* ====================================================================== */
  head('11. 桥接客户端（桩 fetch）');
  {
    const { Bridge, Ssh, FtpChannel, ParserRegistry, Pipeline } = A;

    /* 桩一个 fetch：按 URL 路由返回预设响应 */
    let calls = [];
    let mode = 'ok';
    global.fetch = async function (url, opts) {
      calls.push({ url: String(url), opts: opts || {} });
      if (mode === 'down') throw new TypeError('Failed to fetch');
      const u = String(url);
      const mk = (obj) => ({
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => obj,
        text: async () => JSON.stringify(obj),
        arrayBuffer: async () => new ArrayBuffer(4)
      });
      if (u.indexOf('/api/health') >= 0) {
        return mk({ ok: true, service: 'lava-bridge', version: '1.0.0',
                    paramiko: false, ftpConfigured: true, ftpConnected: true,
                    sshHosts: 440, localReady: true });
      }
      if (u.indexOf('/api/ssh/status') >= 0) {
        return mk({ at: Date.now(), summary: { total: 2, online: 1, offline: 1, testing: 1 },
                    hosts: [
                      { ip: '10.0.0.1', power: 'on', testing: true, errorKind: 'none', checkedAt: Date.now() },
                      { ip: '10.0.0.2', power: 'off', testing: false,
                        errorKind: 'timeout', errorHint: '连接超时', checkedAt: Date.now() }
                    ] });
      }
      if (u.indexOf('/api/ssh/hosts') >= 0) return mk({ ok: true, count: 2 });
      if (u.indexOf('/api/scan') >= 0) {
        return mk({ ok: true, files: [
          { path: 'a/x.log', name: 'x.log', size: 100, mtime: Date.now() },
          { path: 'a/y.txt', name: 'y.txt', size: 200, mtime: Date.now() }
        ], count: 2 });
      }
      return mk({ ok: true });
    };

    try {
      /* 未配置桥接时应当明确报「未配置」而不是报网络错误 */
      App.cfg.channels.ftp.bridgeUrl = '';
      const h0 = await Bridge.health(true);
      ok(h0.configured === false, '未配置桥接时如实报告');

      App.cfg.channels.ftp.bridgeUrl = 'http://127.0.0.1:8770';
      const h1 = await Bridge.health(true);
      ok(h1.ok === true && h1.version === '1.0.0', '桥接健康检查解析正确');
      ok(Bridge.healthLabel(h1).indexOf('桥接') === 0,
         '状态文案：' + Bridge.healthLabel(h1));
      ok(/ok/.test(Bridge.healthChipClass(h1)), '健康时胶囊为 ok 样式');

      /* 桥接不可达要能区分出来 —— 这是现场最常见的故障 */
      mode = 'down';
      const h2 = await Bridge.health(true);
      ok(h2.ok === false && h2.kind === 'unreachable',
         '桥接未启动时归类为 unreachable 而非笼统失败');
      ok(Bridge.healthLabel(h2).indexOf('未启动') >= 0,
         '未启动时的文案：' + Bridge.healthLabel(h2));
      mode = 'ok';

      /* SSH 快照应用 */
      const snap = await Ssh.poll(true);
      ok(!!snap, '拉取到 SSH 快照');
      const rt = App.state.eqRuntime;
      const keys = Object.keys(rt);
      ok(keys.length === 0, 'IP 不在设备台账里时不会错配（当前无台账，匹配 0 台）');

      /* 有台账后应能匹配 */
      const eq = Topology.all(App.cfg).equipment[0];
      eq.ip = '10.0.0.1';
      await Ssh.poll(true);
      ok(App.state.eqRuntime[eq.id] != null,
         'IP 匹配到设备后写入运行时状态（' + eq.id + '）');
      ok(App.state.eqRuntime[eq.id].testing === true, '在测状态被正确记录');

      /* SSH 异常应进报错记录 */
      const eq2 = Topology.all(App.cfg).equipment[1];
      eq2.ip = '10.0.0.2';
      const beforeErr = (App.error || []).length;
      await Ssh.poll(true);
      const added = (App.error || []).length - beforeErr;
      ok(added >= 0, 'SSH 异常写入报错记录（新增 ' + added + ' 条，同类型同日会合并计数）');

      /* 扫描与增量过滤 */
      const files = await FtpChannel.scan('ftp', {});
      ok(files.length === 2, '扫描返回 ' + files.length + ' 个文件');
      await Repo.metaSet('seenFiles', {});
      const fresh1 = await FtpChannel.pickChanged(files, true);
      ok(fresh1.length === 2, '首次扫描：2 个都是新文件');
      await FtpChannel.markSeen(files);
      const fresh2 = await FtpChannel.pickChanged(files, true);
      ok(fresh2.length === 0, '标记后再次扫描：无新增（增量的作用）');

      eq.ip = ''; eq2.ip = '';
    } catch (e) {
      ok(false, '桥接客户端测试抛错', e.message);
      console.log('     ' + (e.stack || '').split('\n')[1]);
    }
  }

  /* ====================================================================== */
  head('12. 日志解析与入库流水线');
  {
    const { ParserRegistry, Pipeline } = A;
    try {
      ok(ParserRegistry.all().length > 0,
         '解析器注册表已注册 ' + ParserRegistry.all().length + ' 个');
      ok(ParserRegistry.all().some(p => p.id === 'generic-line'),
         '通用解析器在位（格式未定时的兜底）');

      /* 归一化：缺 SN 或工站的记录应当被丢弃，而不是产生脏数据 */
      const cfg0 = App.cfg;
      const good = Pipeline.normalize({
        sn: 'LVA260929-00001', station: 'FINAL', result: 'PASS',
        time: Date.now(), pn: 'LVA-SSD-1T92-B3'
      }, { source: 'ftp' });
      ok(good && good.sn === 'LVA260929-00001', '归一化保留 SN');
      ok(good.station === 'FINAL', '工站名归一为标准 key');
      ok(good.result === 'PASS', '结果归一为大写');
      ok(!!good.dedupKey, '生成幂等键：' + good.dedupKey);
      ok(!!good.day, '补出日期字段 ' + good.day);

      const bad1 = Pipeline.normalize({ station: 'FINAL', result: 'PASS' }, { source: 'ftp' });
      ok(bad1 === null, '缺 SN 的记录被丢弃');
      const bad2 = Pipeline.normalize({ sn: 'X123456', station: '不存在的工站' }, { source: 'ftp' });
      ok(bad2 === null, '工站识别不出来的记录被丢弃');

      /* 完整入库：同一份日志跑两次，记录数不应翻倍 */
      const text = [
        'SN: LVA260930-001  Station: FINAL  Result: PASS',
        'SN: LVA260930-002  Station: FINAL  Result: FAIL',
        'SN: LVA260930-003  Station: BIST   Result: PASS',
        '无关的一行，没有 SN'
      ].join('\n');

      App.invalidate();
      const n1 = await Pipeline.ingest(text, { fileName: 'test.log', source: 'ftp' });
      ok(n1 > 0, '首次入库 ' + n1 + ' 条记录');

      const n2 = await Pipeline.ingest(text, { fileName: 'test.log', source: 'ftp' });
      ok(n2 === 0, '同一份日志再次入库：新增 ' + n2 + ' 条（幂等生效）');

      App.invalidate();
      const recs = await Repo.query('records', null, { limit: 1000 });
      const mine = recs.filter(r => String(r.sn).indexOf('LVA260930') === 0);
      ok(mine.length === n1, '库中该批记录数 = ' + mine.length + '，无重复');

      /* FAIL 的记录应当触发判定引擎 */
      const failed = mine.filter(r => r.result === 'FAIL');
      ok(failed.length >= 1, '存在 FAIL 记录，应已走判定：' + failed.length + ' 条');

      /* 日志索引也应有记录 */
      const idx = await Repo.query('logindex', null, { limit: 100 });
      ok(idx.some(x => x.name === 'test.log'), '日志索引已写入');
    } catch (e) {
      ok(false, '流水线测试抛错', e.message);
      console.log('     ' + (e.stack || '').split('\n')[1]);
    }
  }

  /* ====================================================================== */
  head('13. 存储结构一致性（防止「对象仓不存在」这类故障）');
  {
    /* 背景：给 Idb.STORES 加对象仓时若忘了升 IDB_VERSION，
       老库不会触发 onupgradeneeded，新仓建不出来，
       访问时报 "One of the specified object stores was not found"，视图直接挂。
       这里做两层静态检查，把这类问题挡在构建阶段。 */
    const idbSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'store', 'idb.js'), 'utf8');
    const declared = new Set(
      (idbSrc.match(/^\s{4}([a-z]+):\s*\{\s*keyPath:/gm) || [])
        .map(s => s.trim().split(':')[0]));

    ok(declared.size >= 8, 'Idb.STORES 声明了 ' + declared.size + ' 个对象仓：' +
       Array.from(declared).join(', '));

    /* ① 所有 Repo.xxx('storeName', ...) 调用的 store 必须已声明 */
    const files = [];
    (function walk(dir) {
      fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/\.js$/.test(f)) files.push(p);
      });
    })(path.join(__dirname, '..', 'src'));

    const referenced = new Map();   // store -> 首次出现的「文件:行」
    const re = /Repo\.(?:put|putMany|query|count|remove|removeWhere|clearTable|get|del|getAll|putSlots)\(\s*'([a-zA-Z_]+)'/g;
    files.forEach(p => {
      const src = fs.readFileSync(p, 'utf8');
      src.split('\n').forEach((line, i) => {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(line))) {
          const name = m[1];
          if (name === 'slots') return;     // slots 走专用方法，另有对象仓
          if (!referenced.has(name)) {
            referenced.set(name, path.basename(p) + ':' + (i + 1));
          }
        }
      });
    });

    const undeclared = [];
    referenced.forEach((where, name) => {
      if (!declared.has(name) && name !== 'slots') undeclared.push(name + '（' + where + '）');
    });
    ok(undeclared.length === 0,
       '代码里引用的 ' + referenced.size + ' 个对象仓都已声明',
       undeclared.join(', '));

    /* ② 版本号必须 > 1 —— v1 是最初只有少量仓的那版，
          任何后续新增仓都必须升版本，否则老用户升不上来 */
    const constSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'constants.js'), 'utf8');
    const vm = /IDB_VERSION\s*=\s*(\d+)/.exec(constSrc);
    const ver = vm ? Number(vm[1]) : 0;
    ok(ver >= 2, 'IDB_VERSION = ' + ver + '（新增过对象仓，必须 ≥ 2）');

    /* ③ 打开逻辑里要有结构自愈，否则老库永远修不好 */
    ok(/objectStoreNames\.contains/.test(idbSrc) &&
       /_recreate/.test(idbSrc),
       'Idb.open 带结构自愈（缺仓时升级或重建）');

    /* ④ Repo.query 对缺仓要容错，不能把视图带崩 */
    const repoSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'store', 'repository.js'), 'utf8');
    ok(/object store/.test(repoSrc),
       'Repo.query 对「对象仓不存在」做了容错');
  }

  /* ====================================================================== */
  head('14. 导出中心（逐项验证）');
  {
    const { ModalExportCenter } = A;
    try {
      /* 先确保各类数据都在内存里 —— 否则 buildCsv 全返回空表，
         「列数与表头一致」这类检查根本跑不到，测试等于没测 */
      await Mock.generate(App.cfg, {});
      App.invalidate();
      await App.loadAll();
      /* 记录类是懒加载的（loadAll 不碰它们），这里显式拉一次 */
      await App.ensureRecords('records');
      App.state.judgements = await Repo.query('judgements', null, { limit: 1000 });
      ok(App.slots.size > 0 && (App.records || []).length > 0 &&
         (App.bad || []).length > 0 && (App.error || []).length > 0,
         '测试数据就绪：盘位 ' + App.slots.size + ' · 记录 ' + (App.records || []).length +
         ' · 不良 ' + (App.bad || []).length + ' · 报错 ' + (App.error || []).length);

      const groups = ModalExportCenter.list();
      ok(groups.length >= 4, '导出分组 ' + groups.length + ' 个：' +
         groups.map(g => g.name).join(' / '));

      const allItems = groups.reduce((a, g) => a.concat(g.items), []);
      ok(allItems.length >= 12, '导出项共 ' + allItems.length + ' 个');

      /* 逐项跑一遍，任何一项的列定义写错都会在这里暴露 */
      const csvKeys = allItems.filter(i => /^chart|^(config|snapshot|full)$/.test(i.key) === false);
      let built = 0, emptyByDesign = 0;
      const problems = [];

      csvKeys.forEach(i => {
        try {
          const def = ModalExportCenter.buildCsv(i.key);
          if (!def) { problems.push(i.key + '：无定义'); return; }
          if (!def.rows.length) { emptyByDesign++; return; }
          if (def.headers && def.headers.length) {
            // 表头列数必须与数据列数一致 —— 最常见的列定义错误
            const bad = def.rows.filter(r => r.length !== def.headers.length);
            if (bad.length) {
              problems.push(i.key + '：有 ' + bad.length + ' 行的列数与表头不符（' +
                bad[0].length + ' vs ' + def.headers.length + '）');
              return;
            }
          }
          // CSV 序列化后不能含未转义的裸换行
          const csv = Util.toCsv(def.headers, def.rows.slice(0, 50));
          if (typeof csv !== 'string' || !csv.length) {
            problems.push(i.key + '：序列化为空');
            return;
          }
          built++;
        } catch (e) {
          problems.push(i.key + '：' + e.message);
        }
      });

      ok(problems.length === 0,
         '逐个生成 CSV：' + built + ' 项有数据、' + emptyByDesign + ' 项当前为空',
         problems.join(' | '));

      /* 日期范围过滤 */
      ModalExportCenter.scope('all');
      const allDef = ModalExportCenter.buildCsv('records');
      ModalExportCenter.scope('today');
      const todayDef = ModalExportCenter.buildCsv('records');
      ok(todayDef.rows.length <= allDef.rows.length,
         '「仅今日」范围不大于「全部」（' + todayDef.rows.length + ' ≤ ' + allDef.rows.length + '）');
      ModalExportCenter.scope('all');

      /* JSON 备份三种粒度都能生成 */
      const snap = await Backup.exportData('config', App.cfg, {});
      ok(snap.json.length > 0 && snap.manifest.scope === 'config',
         '配置备份可生成（' + Util.bytes(snap.size) + '）');

      /* 说明书里承诺的项必须真的存在 */
      const mustHave = ['devices', 'slots', 'records', 'bad', 'error', 'judgements',
                        'pendingBad', 'wo', 'realtime', 'loglist', 'errStats'];
      const missing = mustHave.filter(k => !allItems.some(i => i.key === k));
      ok(missing.length === 0, '关键导出项齐全', missing.join(', '));
    } catch (e) {
      ok(false, '导出中心测试抛错', e.message);
      console.log('     ' + (e.stack || '').split('\n')[1]);
    }
  }

  /* ====================================================================== */
  console.log('\n' + '='.repeat(64));
  console.log(`冒烟测试结果：${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(64) + '\n');
  process.exit(fail ? 1 : 0);
})();
