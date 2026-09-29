/* ============================================================================
   平面图 —— 按工站分区，逐台显示盘位测试状态
   ----------------------------------------------------------------------------
   显示规则：
     有盘位在测/有结果的设备 → 显示（逐格彩色网格）
     完全空载的设备          → **默认隐藏**

   为什么隐藏空载：产线不会一直满测，空设备只是噪音。
   满配 12,737 盘位里若大部分是空位，全画出来反而看不出哪台在跑。
   需要时可在图例处勾选「显示空载设备」。

   刷新走增量补丁：维护 key → 元素索引，只改变化的格。
   ============================================================================ */

const ViewFloor = (() => {

  let _sections = {};          // stationKey → { bodyEl, index:Map }

  function folded() { return LocalStore.ui.get('folded', {}); }
  function setFolded(k, v) {
    const f = folded(); f[k] = v; LocalStore.ui.set('folded', f);
  }
  function showEmpty() { return !!LocalStore.ui.get('showEmptyEq', false); }
  function setShowEmpty(v) { LocalStore.ui.set('showEmptyEq', !!v); }

  /* 一台设备是否「有内容」：只要有一个盘位非空就算 */
  function hasContent(eq) {
    for (let i = 0; i < eq.capacity; i++) {
      const r = App.slots.get(eq.slotKeys[i]);
      if (r && r.state !== 'empty') return true;
    }
    return false;
  }

  /* 当前应显示哪些设备 */
  function visibleEquipments(stationKey, cfg) {
    const eqs = Topology.all(cfg).stationsMap[stationKey] || [];
    if (showEmpty()) return eqs;
    return eqs.filter(hasContent);
  }

  /* --------------------------------------------------------------------------
     渲染
     -------------------------------------------------------------------------- */
  function render() {
    const cfg = App.cfg;
    const filter = LocalStore.ui.get('stationFilter', '');
    const stations = filter
      ? Topology.effectiveStations(cfg).filter(s => s.key === filter)
      : Topology.effectiveStations(cfg);

    _sections = {};
    const html = stations.map(s => sectionHTML(s, cfg)).join('');
    Dom.html('floorBody', html || '<div class="empty-tip">无工站配置</div>');

    // 建索引供增量补丁：必须用「实际渲染出来的」设备列表，顺序才对得上
    stations.forEach(s => {
      const bodyEl = document.querySelector('#floorBody .sec-body[data-st="' + s.key + '"]');
      if (!bodyEl) return;
      const rendered = visibleEquipments(s.key, cfg);
      _sections[s.key] = { bodyEl, index: buildIndex(bodyEl, s.key, rendered) };
    });

    renderStrip();
    syncShowEmptyToggle();
  }

  /* 索引按「设备循环 × 盘位循环」对齐 querySelectorAll 的文档序。
     机柜布局下设备的文档序同样是按设备逐个发射的，故仍成立。 */
  function buildIndex(container, stationKey, equipmentList) {
    const index = new Map();
    if (!container) return index;
    const cells = container.querySelectorAll('.cell[data-k]');
    let i = 0;
    for (let e = 0; e < equipmentList.length; e++) {
      const eq = equipmentList[e];
      for (let s = 0; s < eq.capacity; s++) {
        const node = cells[i++];
        if (!node) break;
        index.set(eq.slotKeys[s], node);
      }
    }
    return index;
  }

  function renderStrip() {
    const cfg = App.cfg;
    const cur = LocalStore.ui.get('stationFilter', '');
    const topo = Topology.all(cfg);
    Dom.html('stationStrip', Topology.summary(cfg).map(s => {
      const eqs = topo.stationsMap[s.station] || [];
      const c = SlotGrid.countStates(eqs, App.slots);
      const active = eqs.filter(hasContent).length;
      return '<div class="schip' + (cur === s.station ? ' active' : '') +
          '" data-st="' + s.station + '" title="点击只看该工站">' +
        '<div class="nm"><i class="dot" style="background:' + s.color + '"></i>' + s.name + '</div>' +
        '<div class="mt">' + active + '/' + s.eqCount + ' ' + s.unit + '在跑 · ' +
          Util.num(c.used) + '/' + Util.num(c.cap) + ' 盘位</div>' +
        '<div class="bar"><i style="width:' + (c.util * 100).toFixed(1) +
          '%;background:' + s.color + '"></i></div>' +
      '</div>';
    }).join(''));
  }

  /* --------------------------------------------------------------------------
     单个工站分区
     -------------------------------------------------------------------------- */
  function sectionHTML(s, cfg) {
    const topo = Topology.all(cfg);
    const allEqs = topo.stationsMap[s.key] || [];
    if (!allEqs.length) return '';

    const visible = visibleEquipments(s.key, cfg);
    const hiddenCount = allEqs.length - visible.length;
    const c = SlotGrid.countStates(allEqs, App.slots);
    const ov = Capacity.overview(cfg).rows.filter(r => r.station === s.key)[0] || {};
    const isFolded = !!folded()[s.key];
    const cabCount = s.layout === 'cabinet' ? Topology.cabinetCount(cfg, s.key) : 0;
    const activeEq = allEqs.length - hiddenCount;
    const pending = App.pendingBadKeys();

    let body;
    if (!visible.length) {
      body = '<div class="empty-tip">该工站当前无在跑设备' +
        (hiddenCount ? '（' + hiddenCount + ' 台空载已隐藏）' : '') + '</div>';
    } else if (s.layout === 'flat') {
      body = '<div class="eq-wrap">' + visible.map(eq =>
        SlotGrid.flatCardHTML(s.key, eq, App.slots,
          App.eqState(s.key, eq.id), { pending })).join('') + '</div>';
    } else {
      // 机柜布局：按机柜分组，柜内只保留有内容的服务器
      const allCabs = Topology.cabinets(cfg, s.key);
      const visIds = new Set(visible.map(e => e.id));
      const cabs = allCabs
        .map(cab => ({ cab, servers: cab.servers.filter(e => visIds.has(e.id)) }))
        .filter(x => x.servers.length);
      body = '<div class="cab-wrap">' + cabs.map(({ cab, servers }) => {
        const states = {};
        servers.forEach(eq => { states[eq.id] = App.eqState(s.key, eq.id); });
        return SlotGrid.cabinetHTML(s.key, { id: cab.id, servers, slotCount: servers.length * s.capacity },
          App.slots, states, { pending });
      }).join('') + '</div>';
    }

    const hiddenNote = hiddenCount
      ? '<div class="hint" style="margin:0 0 10px">' +
        '已隐藏 <b>' + hiddenCount + '</b> 台空载设备' +
        (showEmpty() ? '' : '（图例处可勾选显示）') + '</div>'
      : '';

    return '<div class="sec">' +
      '<div class="sec-head" data-toggle-sec="' + s.key + '">' +
        '<i class="bar-l" style="background:' + s.color + '"></i>' +
        '<div>' +
          '<div class="t">' + s.name +
            '<span class="sub">' + s.cn + ' · ' + s.full + '</span>' +
            (ov.isBottleneck ? '<span class="badge b-fault">瓶颈</span>' : '') +
          '</div>' +
          '<div class="sub">' + activeEq + '/' + s.eqCount + ' ' + s.unit + '在跑' +
            (cabCount ? ' · ' + cabCount + ' 机柜' : '') +
            ' · 单台 ' + s.capacity + ' 盘位 · 单轮 ' + Util.fmtCycle(s.cycleMin) +
            ' · 上料 ' + s.loads +
            (s.sampling ? ' · 抽检 ' + (s.sampling * 100) + '%' : '') +
          '</div>' +
        '</div>' +
        '<div class="kpis">' +
          '<span>占用 <b>' + Util.num(c.used) + '</b></span>' +
          '<span>空闲位 <b>' + Util.num(c.free) + '</b></span>' +
          '<span>在测 <b>' + Util.num(c.testing) + '</b></span>' +
          '<span class="c-pass">通过 <b>' + Util.num(c.pass) + '</b></span>' +
          '<span class="c-fail">失败 <b>' + Util.num(c.fail) + '</b></span>' +
          '<span>利用率 <b>' + (c.util * 100).toFixed(1) + '%</b></span>' +
        '</div>' +
        '<span class="fold-tag">' + (isFolded ? '展开' : '折叠') + '</span>' +
      '</div>' +
      '<div class="sec-body' + (isFolded ? ' hide' : '') + '" data-st="' + s.key + '">' +
        hiddenNote + body +
      '</div>' +
    '</div>';
  }

  /* --------------------------------------------------------------------------
     增量刷新
     -------------------------------------------------------------------------- */
  function refresh(changedKeys) {
    if (!changedKeys || !App.canPatch) { render(); return 0; }

    /* 变更可能让一台原来空载的设备变成有内容，或反过来。
       前者需要它出现（当前索引里没有），后者需要它消失（索引里有但应移除）。
       这两种情况无法靠 patch 处理，直接整站重渲染更稳；其余走 patch。 */
    let needFullRender = false;
    const touchedStations = new Set();
    changedKeys.forEach(k => {
      const p = Schema.parseSlotKey(k);
      if (p.station) touchedStations.add(p.station);

      const rec = App.slots.get(k);
      const nowHas = !!(rec && rec.state !== 'empty');
      const wasTracked = Object.keys(_sections).some(st =>
        _sections[st] && _sections[st].index.has(k));
      // 有 → 无（设备变空了）或 无 → 有（设备刚上料）都会改变可见集合
      if (nowHas !== wasTracked) needFullRender = true;
    });

    if (needFullRender) { render(); return 0; }

    const pending = App.pendingBadKeys();
    let n = 0;
    touchedStations.forEach(st => {
      const sec = _sections[st];
      if (sec && sec.index.size) n += SlotGrid.patch(sec.index, changedKeys, App.slots, pending);
    });
    if (!n && changedKeys.size) { render(); return 0; }
    renderStrip();
    return n;
  }

  function syncShowEmptyToggle() {
    const cb = document.getElementById('chkShowEmpty');
    if (cb) cb.checked = showEmpty();
  }

  /* --------------------------------------------------------------------------
     交互
     -------------------------------------------------------------------------- */
  function bind() {
    Dom.delegate('stationStrip', 'click', '.schip', (e, el) => {
      const k = el.dataset.st;
      const cur = LocalStore.ui.get('stationFilter', '');
      LocalStore.ui.set('stationFilter', cur === k ? '' : k);
      render();
    });

    Dom.delegate('floorBody', 'click', '[data-toggle-sec]', (e, el) => {
      if (e.target.closest('.cell')) return;
      const k = el.dataset.toggleSec;
      setFolded(k, !folded()[k]);
      render();
    });

    Dom.delegate('floorBody', 'click', '.cell[data-k]', (e, el) => {
      const rec = App.slots.get(el.dataset.k);
      if (!rec || !rec.sn) return;
      App.openSlotDetail(el.dataset.k);
    });

    const btnFold = document.getElementById('btnFoldAll');
    if (btnFold) {
      btnFold.onclick = () => {
        const f = folded();
        const anyOpen = Topology.effectiveStations(App.cfg).some(s => !f[s.key]);
        Topology.effectiveStations(App.cfg).forEach(s => { f[s.key] = anyOpen; });
        LocalStore.ui.set('folded', f);
        render();
      };
    }

    const chk = document.getElementById('chkShowEmpty');
    if (chk) {
      chk.onchange = () => { setShowEmpty(chk.checked); render(); };
    }
  }

  /* 无渲染后置操作（保持与主控的接口一致） */
  function afterRender() { return 0; }

  return { render, refresh, bind, renderStrip, afterRender, hasContent, visibleEquipments };
})();
