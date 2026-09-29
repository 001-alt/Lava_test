/* ============================================================================
   主控 —— 运行时状态、视图路由、初始化
   ----------------------------------------------------------------------------
   App 是全局运行时缓存：配置来自 localStorage，大数据来自 Repo。
   盘位在内存里保留一份 Map（只含非空盘位），视图直接读它，
   避免每次渲染都去 IndexedDB 查 12,737 条。
   ============================================================================ */

const App = (() => {

  const state = {
    cfg: null,
    slots: new Map(),          // slotKey → slot 对象（仅非空）
    eqStates: {},              // equipmentId → run|idle|fault|maint
    workOrders: [],
    devices: [],               // 设备台账（真实设备身份与位置/IP）
    eqRuntime: {},             // 设备运行时状态（SSH 巡检写入）
    lastSshAt: 0,              // 最近一次巡检时间
    records: null,             // 懒加载缓存
    bad: null,
    error: null,
    logindex: null,
    curView: 'floor',
    canPatch: false,           // 首屏渲染完成后才允许增量补丁
    lastChanged: null,
    ticks: { render: null, ssh: null, slt: null },
    bootedAt: Date.now()
  };

  /* ==========================================================================
     数据访问
     ========================================================================== */
  function pendingBadKeys() {
    const set = new Set();
    (state.bad || []).forEach(b => {
      if (b.confirmed) return;
      if (b.slotIndex == null) return;
      set.add(Schema.slotKey(b.station, b.serverId || b.equipmentId || '', b.slotIndex));
    });
    return set;
  }

  /* 设备状态
     优先级：SSH 巡检实测 > 模拟数据 > 按盘位占用粗判
     巡检才是真相 —— 模拟数据与占用推断只是没有巡检时的占位。 */
  function eqState(station, equipmentId) {
    // ① SSH 巡检结果（最可信）
    const rt = state.eqRuntime && state.eqRuntime[equipmentId];
    if (rt && rt.errorKind && rt.errorKind !== 'none') return 'fault';
    if (rt && rt.power === 'off') return 'idle';      // 关机视为空闲而非故障
    if (rt && rt.power === 'on') return rt.testing ? 'run' : 'idle';

    // ② 模拟数据（开发/演示）
    const k = station + '|' + equipmentId;
    if (state.eqStates[k] != null) return state.eqStates[k];

    // ③ 兜底：按盘位占用粗判
    const eqs = (Topology.all(state.cfg).stationsMap[station] || [])
      .filter(e => e.id === equipmentId)[0];
    if (!eqs) return 'idle';
    let used = 0;
    for (let i = 0; i < eqs.capacity; i++) {
      const r = state.slots.get(eqs.slotKeys[i]);
      if (r && r.state !== 'empty') used++;
    }
    return used > 0 ? 'run' : 'idle';
  }

  /* 设备运行时的详细信息（供 tooltip 展示「N 秒前巡检」这类新鲜度信息） */
  function eqRuntime(equipmentId) {
    return (state.eqRuntime && state.eqRuntime[equipmentId]) || null;
  }

  /* 巡检快照的整体新鲜度 */
  function sshFreshness() {
    if (!state.lastSshAt) return { level: 'none', text: '未巡检', sec: null };
    return Util.freshness(state.lastSshAt);
  }

  async function loadAll() {
    const t0 = Date.now();
    const all = await Repo.getAllSlots();
    state.slots = new Map();
    all.forEach(s => { if (s.state && s.state !== 'empty') state.slots.set(s.key, s); });
    state.bad = await Repo.query('bad', null, { limit: 200000 });
    state.error = await Repo.query('error', null, { limit: 200000 });
    state.workOrders = await Repo.query('workorders', null, { limit: 5000 });

    /* 设备台账：有则切到「真实台账」拓扑模式，设备编号 = 真实机柜号+位号 */
    state.devices = await Repo.query('devices', null, { limit: 50000 });
    Topology.setRegistry(state.devices.length ? state.devices : null);

    console.info('[App] 载入 ' + state.slots.size + ' 个非空盘位' +
      '，设备台账 ' + state.devices.length + ' 台' +
      '，拓扑来源 ' + Topology.all(state.cfg).source +
      '，耗时 ' + (Date.now() - t0) + 'ms');
    return state.slots.size;
  }

  /* 保存设备台账（整体替换） */
  async function saveDevices(list) {
    await Repo.clearTable('devices');
    if (list && list.length) {
      const CH = 2000;
      for (let i = 0; i < list.length; i += CH) {
        await Repo.putMany('devices', list.slice(i, i + CH));
      }
    }
    state.devices = (list || []).slice();
    Topology.setRegistry(state.devices.length ? state.devices : null);
    return state.devices.length;
  }

  /* 写盘位并记录变更集，供视图增量补丁 */
  async function saveSlots(slots) {
    await Repo.putSlots(slots);
    slots.forEach(s => {
      if (s.state === 'empty' && !s.sn) state.slots.delete(s.key);
      else state.slots.set(s.key, s);
    });
    state.lastChanged = new Set(slots.map(s => s.key));
    Bus.emit(EVT.SLOTS_CHANGED, { keys: state.lastChanged });
    return slots.length;
  }

  /* ==========================================================================
     视图路由
     ========================================================================== */
  const RENDERERS = {
    /* 平面图分两步：先渲染卡片骨架，再挂载已展开的盘位网格
       （网格是 DOM 引用级操作，没法在字符串拼接阶段完成） */
    floor: async () => { await ViewFloor.render(); ViewFloor.afterRender(); },
    board: () => ViewBoard.render(),
    daily: () => ViewDaily.render(),
    stats: () => ViewStats.render(),
    bad: () => ViewBad.render(),
    error: () => ViewError.render(),
    pull: () => ViewPull.render(),
    wo: () => ViewWo.render(),
    log: () => ViewLog.render(),
    trace: () => ViewTrace.render()
  };

  /* 渲染序号：视图渲染函数是 async（要先 await 数据），快速切换时
     旧渲染可能晚于新渲染返回。每次切换递增序号并在完成后比对，
     过期结果直接丢弃，避免「已经切走了还在往里写」的串台。 */
  let _renderSeq = 0;

  async function switchView(key) {
    const v = VIEWS.filter(x => x.key === key)[0];
    if (!v) return;
    state.curView = key;
    LocalStore.ui.set('curView', key);
    Dom.$$('#viewTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === key));
    Dom.$$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + key));

    const seq = ++_renderSeq;
    try {
      const fn = RENDERERS[key];
      if (fn) await fn();
      if (seq !== _renderSeq) return;       // 已被更晚的切换取代
    } catch (e) {
      if (seq !== _renderSeq) return;
      console.error('[App] 渲染 ' + key + ' 出错：', e);
      Toast.error('「' + v.name + '」渲染出错：' + e.message);
    }
    Bus.emit(EVT.VIEW_SWITCH, key);
  }

  /* ==========================================================================
     盘位详情抽屉
     ========================================================================== */
  function openSlotDetail(key) {
    const rec = state.slots.get(key);
    if (!rec) { Toast.warn('该盘位为空'); return; }
    const loc = Topology.locate(state.cfg, key);
    const st = ST[loc.station];
    const wo = state.workOrders.filter(w => w.no === rec.woNo)[0];
    const isOrt = Sampling.isSampled(rec.sn);

    // 该 SN 在各工站的记录（懒加载）
    const recs = (state.records || []).filter(r => r.sn === rec.sn);
    const chain = recs.length
      ? Trace.bySn(rec.sn, recs).chain
      : null;

    // 没有历史记录时，用「当前所在工站」推一条简化链
    const fallbackChain = MAINLINE.concat(['ORT']).map((k, i) => {
      const order = MAINLINE.indexOf(k);
      const curOrder = MAINLINE.indexOf(loc.station);
      let st2 = 'pending';
      if (k === 'ORT') st2 = 'pending';
      else if (order < curOrder) st2 = 'pass';
      else if (order === curOrder) st2 = rec.state === 'testing' ? 'testing'
                                       : rec.state === 'pass' ? 'pass'
                                       : rec.state === 'fail' ? 'fail'
                                       : rec.state === 'abort' ? 'abort' : 'pending';
      return { station: k, state: st2, records: [], last: null,
               bypass: k === 'ORT',
               detail: k === 'ORT' ? (isOrt ? '已抽中（2.5% 抽样）' : '未抽中（2.5% 抽样）') : '' };
    });

    const remaining = rec.state === 'testing' && rec.startTime && st
      ? rec.startTime + st.cycleMin * 60000 - Date.now() : null;

    const body =
      '<dl class="kv">' +
        '<dt>工单</dt><dd>' + Util.esc(rec.woNo || '--') + '</dd>' +
        '<dt>PN / 型号</dt><dd>' + Util.esc(rec.pn || '--') +
          (rec.model ? ' <span style="color:var(--tx-3)">' + Util.esc(rec.model) + '</span>' : '') + '</dd>' +
        '<dt>当前工站</dt><dd>' + Util.esc(st.name + ' · ' + st.cn) + '</dd>' +
        (loc.cabinetId ? '<dt>所属机柜</dt><dd>' + Util.esc(loc.cabinetId) + '</dd>' : '') +
        '<dt>设备</dt><dd>' + Util.esc(loc.equipmentId) + '</dd>' +
        '<dt>位号</dt><dd>第 ' + (loc.slotIndex + 1) + ' 位 / 共 ' + st.capacity + '</dd>' +
        '<dt>当前状态</dt><dd><span class="pill ' + L.statePill(rec.state) + '">' +
          Util.esc(L.slotState(rec.state)) + '</span></dd>' +
        (rec.errCode ? '<dt>错误码</dt><dd style="color:#ff8b82">' + Util.esc(rec.errCode) + '</dd>' : '') +
        (rec.startTime ? '<dt>开始时间</dt><dd>' + Util.fmtFull(rec.startTime) + '</dd>' : '') +
        (remaining != null ? '<dt>预计剩余</dt><dd>' +
          (remaining > 0 ? Util.fmtDur(remaining) : '已超时') + '</dd>' : '') +
        (wo ? '<dt>工单进度</dt><dd>' + Util.esc(wo.no) + ' · ' +
          Util.esc(L.woState(wo.status)) + '</dd>' : '') +
      '</dl>' +
      '<div style="font-size:13px;font-weight:600;margin-bottom:12px">工序流转</div>' +
      Timeline.flow(chain || fallbackChain, { currentStation: loc.station }) +
      (chain ? '' :
        '<div class="note warn" style="margin-top:14px">' +
        '该 SN 暂无历史测试记录，上图按「推断」展示：已过工站标为通过。<br>' +
        '接入真实数据后（SSH / FTP / 本地目录）会显示每站的实际时间与结果。</div>') +
      '<div class="note" style="margin-top:14px">' +
        'ORT 为<b>旁路抽检</b>：按 2.5% 从 FINAL 产出中抽取，不阻塞主线放行。' +
        '本块 SN ' + (isOrt ? '<b style="color:#7fb3ff">已抽中</b>' : '未抽中') + '。</div>';

    const head =
      '<dl class="kv" style="margin-bottom:0">' +
      '</dl>';

    Drawer.open({
      title: rec.sn,
      sub: (rec.model || rec.pn || '') + (rec.woNo ? ' · ' + rec.woNo : ''),
      body,
      actions: '<button class="btn sm" data-detail-trace="1">在追溯页查看</button>',
      onMount(el) {
        el.addEventListener('click', e => {
          if (e.target.closest('[data-detail-trace]')) {
            Drawer.close();
            LocalStore.ui.set('traceQuery', rec.sn);
            switchView('trace');
          }
        });
      }
    });
  }

  /* --------------------------------------------------------------------------
     判定引擎的依赖注入
     领域层（domain/）刻意不引用 store，由这里把存储能力喂给它，
     这样 DefectEngine 保持纯逻辑、可在 Node 下测试。
     -------------------------------------------------------------------------- */
  function defectDeps() {
    return {
      cfg: state.cfg,
      findBad: async (ctx) => (state.bad || []).filter(b =>
        b.sn === ctx.sn && b.station === (ctx.station || '')),
      listBad: async (where, opts) => {
        let list = state.bad || [];
        if (where && where.confirmed !== undefined) {
          list = list.filter(b => !!b.confirmed === !!where.confirmed);
        }
        list = list.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
        return opts && opts.limit ? list.slice(0, opts.limit) : list;
      },
      getBad: async (id) => (state.bad || []).filter(b => b.id === id)[0] || null,
      saveBad: async (b) => {
        await Repo.put('bad', b);
        const list = state.bad || (state.bad = []);
        const i = list.findIndex(x => x.id === b.id);
        if (i >= 0) list[i] = b; else list.unshift(b);
        return b.id;
      },
      saveJudgement: async (j) => Repo.put('judgements', j),
      getJudgement: async (id) => Repo.get('judgements', id)
    };
  }

  /* 确保某类记录已加载（视图按需拉取） */
  async function ensureRecords(which) {
    if (which === 'records' && !state.records) {
      state.records = await Repo.query('records', null, { limit: 200000 });
    }
    if (which === 'bad' && !state.bad)   state.bad = await Repo.query('bad', null, { limit: 200000 });
    if (which === 'error' && !state.error) state.error = await Repo.query('error', null, { limit: 200000 });
    if (which === 'logindex' && !state.logindex) state.logindex = await Repo.query('logindex', null, { limit: 20000 });
    return state[which];
  }
  function invalidate(which) {
    if (which) state[which] = null;
    else { state.records = null; state.bad = null; state.error = null; state.logindex = null; }
  }

  /* ==========================================================================
     顶栏状态
     ========================================================================== */
  async function refreshStatus() {
    const chip = document.getElementById('storageChip');
    if (chip) {
      const label = Repo.backendLabel();
      chip.textContent = '存储：' + label;
      chip.className = 'chip ' + (Repo.isDegraded() ? 'warn' : 'ok');
      const est = await Repo.estimate();
      chip.title = '已用 ' + Util.bytes(est.usage) +
                   (est.quota ? ' / ' + Util.bytes(est.quota) +
                     '（' + (est.usedPct * 100).toFixed(1) + '%）' : '') +
                   '\n后端：' + label +
                   '\n非空盘位：' + Util.num(state.slots.size) + ' / ' + Util.num(Topology.all(state.cfg).totalSlots);
    }
    const bchip = document.getElementById('bridgeChip');
    if (bchip) {
      if (typeof Bridge !== 'undefined') {
        const h = await Bridge.health();
        bchip.textContent = Bridge.healthLabel(h);
        bchip.className = Bridge.healthChipClass(h);
        bchip.title = h.ok
          ? '桥接服务正常' +
            (h.uptimeSec ? '，已运行 ' + Math.floor(h.uptimeSec / 60) + ' 分钟' : '') +
            (h.sshHosts ? '\n巡检机台 ' + h.sshHosts + ' 台' : '') +
            (h.paramiko === false ? '\n未装 paramiko，SSH 仅支持密钥认证' : '')
          : (h.configured
              ? '桥接不可达：' + (h.error || '') + '\n请运行 bridge\\启动桥接服务.bat'
              : '尚未配置桥接服务\n浏览器无法直连 FTP/SSH，需经桥接转发');
      } else {
        bchip.textContent = '桥接未配置';
        bchip.className = 'chip';
      }
    }
  }

  /* 降级模式横幅：file:// 下 IndexedDB 不可用时明确告知用户 */
  function renderDegradeBar() {
    const old = document.getElementById('degradeBar');
    if (old) old.remove();
    if (!Repo.isDegraded()) return;
    const isMem = Repo.backend() === 'memory';
    const bar = Dom.el('div', { class: 'degrade-bar', id: 'degradeBar' });
    bar.innerHTML =
      '<span>⚠️ <b>' + (isMem ? '存储不可用' : '降级存储模式') + '</b>：' +
      (isMem
        ? '数据仅存于内存，刷新页面即丢失。请立即到「导出中心」导出备份。'
        : '当前页面以 <code>file://</code> 打开，浏览器禁用了 IndexedDB，' +
          '盘位数据存在紧凑 localStorage 中，容量受限。') +
      '</span>' +
      '<span class="spacer"></span>' +
      (isMem ? '' : '<span>建议：运行 <b>bridge\\启动桥接服务.bat</b>，' +
        '改用 <b>http://127.0.0.1:8770/</b> 打开本页面，可获得完整存储容量。</span>');
    const topbar = document.querySelector('.topbar');
    if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(bar, topbar.nextSibling);
  }

  /* ==========================================================================
     初始化
     ========================================================================== */
  /* 幂等启动：重复调用返回**同一个 Promise**。
     ⚠️ 不能用布尔标志 —— 那会让第二次调用立即返回，而第一次尚未完成，
     调用方以为启动好了就往下走，读到空状态。 */
  let _bootPromise = null;
  function boot() {
    if (_bootPromise) return _bootPromise;
    _bootPromise = _boot();
    return _bootPromise;
  }

  async function _boot() {
    const t0 = Date.now();
    state.cfg = LocalStore.load();

    // 主题尽早应用，避免「先按深色画一帧再跳成浅色」的闪屏
    Theme.init();

    // 存储后端探测（IndexedDB → 紧凑 localStorage → 内存）
    await Repo.init();
    console.info('[App] 存储后端：' + Repo.backendLabel());

    DefectEngine.ensureRules(state.cfg);

    await loadAll();

    // 标签页
    Dom.html('viewTabs', VIEWS.filter(v => v.tab).map(v =>
      '<div class="tab' + (v.key === state.curView ? ' active' : '') +
      '" data-view="' + v.key + '">' + v.name + '</div>').join(''));

    // 工站总览条点击 + 标签页切换
    Dom.delegate('viewTabs', 'click', '.tab', (e, el) => switchView(el.dataset.view));

    // 各视图的局部事件
    ViewFloor.bind();
    if (typeof ViewBad !== 'undefined' && ViewBad.bind) ViewBad.bind();
    if (typeof ViewWo !== 'undefined' && ViewWo.bind) ViewWo.bind();
    if (typeof ViewTrace !== 'undefined' && ViewTrace.bind) ViewTrace.bind();

    // 顶栏按钮
    bindTopbar();

    renderDegradeBar();

    // 首屏：必须 await，否则 boot 的 Promise 会在首屏渲染完成前 resolve，
    // 调用方（含冒烟测试）会读到空的视图容器
    const cur = LocalStore.ui.get('curView', 'floor');
    await switchView(VIEWS.some(v => v.key === cur) ? cur : 'floor');
    await refreshStatus();

    // 首屏渲染完成，此后允许增量补丁
    state.canPatch = true;

    // 关页前落盘
    window.addEventListener('beforeunload', () => { try { Repo.flush(); } catch (e) { } });

    /* 拖放兜底：浏览器默认行为是「把拖进来的文件当作导航目标」，
       即拖一个文件到页面空白处会直接跳走/触发 file:// 导航拦截告警。
       台账的拖放区自己处理了 preventDefault，但页面其它区域也必须拦掉。 */
    ['dragover', 'drop'].forEach(ev => {
      document.addEventListener(ev, e => {
        const inZone = e.target && e.target.closest && e.target.closest('#ledDrop');
        if (inZone) return;              // 交给台账拖放区自己的处理
        e.preventDefault();
      }, false);
    });

    console.info('[App] 启动完成，耗时 ' + (Date.now() - t0) + 'ms');
    if (!state.slots.size) {
      Toast.info('库里暂无数据。点击顶栏「生成模拟数据」查看完整界面，' +
                 '或到「实时拉取」接入真实数据。', '欢迎使用 Lava_test 看板');
    }
  }

  function bindTopbar() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };

    on('btnManualRefresh', () => {
      invalidate();
      loadAll().then(() => {
        switchView(state.curView);
        refreshStatus();
        Toast.ok('已刷新');
      });
    });

    on('btnMock', async () => {
      const ok = await Modal.confirm({
        title: '生成模拟数据',
        html: '将按真实车间配置（<b>12,737 个盘位</b>）生成一整套模拟数据，用于界面验收。<br><br>' +
              '⚠️ 这会<b>清空当前库中的盘位与记录数据</b>。若已有正式数据，请先到「导出中心」备份。',
        okText: '生成', danger: true
      });
      if (!ok) return;
      try {
        const r = await Mock.generate(state.cfg, {
          onProgress: (done, total, label) => {
            if (done % 20000 < 3000) console.log('[Mock] ' + done + '/' + total + ' ' + label);
          }
        });
        // 设备状态回填，供平面图显示
        state.eqStates = {};
        Object.keys(r.eqStates).forEach(id => {
          const eq = Topology.all(state.cfg).equipment.filter(e => e.id === id)[0];
          if (eq) state.eqStates[eq.station + '|' + id] = r.eqStates[id];
        });
        invalidate();
        await loadAll();
        switchView(state.curView);
        await refreshStatus();
        Toast.ok('盘位 ' + Util.num(r.slots) + ' / 记录 ' + Util.num(r.records) +
                 ' / 不良 ' + r.bad + '（待确认 ' + r.badPending + '）/ 报错 ' + r.error,
                 '模拟数据已生成');
      } catch (e) {
        console.error('[Mock] 生成失败：', e);
        Toast.error('生成失败：' + e.message);
      }
    });

    on('btnTheme', () => Theme.cycle());

    on('btnExportCenter', () => {
      if (typeof ModalExportCenter !== 'undefined') ModalExportCenter.open();
      else Toast.warn('导出中心将在后续阶段提供');
    });

    on('btnSettings', () => {
      if (typeof ModalSettings !== 'undefined') ModalSettings.open();
      else Toast.warn('系统设置将在后续阶段提供');
    });

    const btnLedger = document.getElementById('btnLedger');
    if (btnLedger) btnLedger.onclick = () => ModalLedger.open('import');

    const btnAuto = document.getElementById('btnAutoRefresh');
    if (btnAuto) {
      btnAuto.onclick = () => {
        if (!Scheduler.isRunning() && !Bridge.configured()) {
          Toast.warn('尚未配置桥接服务。自动刷新主要用于周期拉取与巡检；' +
                     '无桥接时只能刷新本页视图。', '提示');
        }
        const on = Scheduler.toggle();
        btnAuto.classList.toggle('on', on);
      };
    }
  }

  return {
    state, boot, switchView, openSlotDetail,
    pendingBadKeys, eqState, saveSlots, loadAll,
    ensureRecords, invalidate, refreshStatus, renderDegradeBar, defectDeps, saveDevices,
    eqRuntime, sshFreshness,
    get cfg() { return state.cfg; },
    get slots() { return state.slots; },
    get workOrders() { return state.workOrders; },
    get canPatch() { return state.canPatch; },
    get records() { return state.records; },
    get bad() { return state.bad; },
    get error() { return state.error; },
    get logindex() { return state.logindex; },
    get devices() { return state.devices; }
  };
})();

/* 启动 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.boot());
} else {
  App.boot();
}
