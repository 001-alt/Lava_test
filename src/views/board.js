/* ============================================================================
   智慧现场看板 —— 面向班组的一屏总览
   ----------------------------------------------------------------------------
   与平面图的分工：平面图看「位置」，看板看「今天状况」。
   盘位用 canvas 画（12,737 格不产生任何 DOM），可整屏呈现。
   ============================================================================ */

const ViewBoard = (() => {

  async function render() {
    await App.ensureRecords('records');
    const cfg = App.cfg;
    const topo = Topology.all(cfg);
    const today = Util.todayKey();
    const recs = App.records || [];
    const todayRecs = recs.filter(r => r.day === today);
    const tp = todayRecs.filter(r => String(r.result).toUpperCase() === 'PASS').length;
    const tf = todayRecs.filter(r => String(r.result).toUpperCase() === 'FAIL').length;
    const ta = todayRecs.filter(r => String(r.result).toUpperCase() === 'ABORT').length;
    const y = Capacity.yieldOf({ pass: tp, fail: tf, abort: ta });

    /* 全线统计 */
    let used = 0, testing = 0, total = 0;
    const perStation = [];
    Topology.summary(cfg).forEach(s => {
      const eqs = topo.stationsMap[s.station] || [];
      const c = SlotGrid.countStates(eqs, App.slots);
      used += c.used; testing += c.testing; total += c.cap;
      perStation.push({ s, c });
    });

    /* 故障设备 */
    const faultEqs = [];
    topo.equipment.forEach(eq => {
      const st = App.eqState(eq.station, eq.id);
      if (st === 'fault' || st === 'maint') {
        faultEqs.push({ eq, st });
      }
    });

    /* 待办 */
    const pendingBad = (App.bad || []).filter(b => !b.confirmed).length;
    const openErr = (App.error || []).filter(e => !e.handled).length;
    const runningWo = (App.workOrders || []).filter(w => w.status === 'running').length;

    Dom.html('boardBody',
      '<div class="toolbar">' +
        '<span class="title">智慧现场看板</span>' +
        '<span style="font-size:11.5px;color:var(--tx-3)">' + Util.nowStr() + '</span>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn sm" id="boardGotoFloor">去平面图</button>' +
      '</div>' +

      '<div class="kpi-wall">' +
        kpi('全线在制', Util.num(used),
            '容量 ' + Util.num(total) + ' · 利用率 ' + (total ? (used / total * 100).toFixed(1) : 0) + '%') +
        kpi('测试中', Util.num(testing), '正在跑的盘位', 'var(--info)') +
        kpi('今日通过', Util.num(tp), 'FAIL ' + Util.num(tf), 'var(--ok)') +
        kpi('今日良率', y.pct == null ? '--' : (y.pct * 100).toFixed(2) + '%',
            y.formula, y.pct != null && y.pct >= 0.95 ? 'var(--ok)' : 'var(--warn)') +
        kpi('异常终止', Util.num(ta), '数据不完整，不计入良率', 'var(--abort)') +
        kpi('待确认不良', Util.num(pendingBad), '需人工判定', pendingBad ? 'var(--warn)' : 'var(--tx)') +
        kpi('待处理报错', Util.num(openErr), '设备侧异常', openErr ? 'var(--bad)' : 'var(--tx)') +
        kpi('在产工单', Util.num(runningWo), '生产中', 'var(--info)') +
      '</div>' +

      '<div class="section-title">各工站负载</div>' +
      Charts.barH(perStation.map(x => ({
        label: x.s.name, value: Math.round(x.c.util * 100), color: x.s.color,
        tag: x.s.isBottleneck ? ' <span class="badge b-fault">瓶颈</span>' : ''
      })), {
        fmt: v => v + '%',
        note: perStation.map(x => x.s.name + ' ' + Util.num(x.c.used) + '/' + Util.num(x.c.cap)).join(' · ')
      }) +

      '<div class="section-title">全线热力图' +
        '<span class="note-inline">按需绘制 —— 12,737 格，不产生 DOM</span></div>' +
      '<div class="bar-chart">' +
        '<div class="toolbar" style="margin-bottom:11px">' +
          '<button class="btn sm" id="boardHeatToggle">绘制热力图</button>' +
          '<span class="hint" style="margin:0">' +
            '每格一个盘位，按工站顺序排列。用于判断整线负载是否均匀 —— ' +
            '大片连续的「在测」说明该工站满载。默认不绘制，避免无谓开销。' +
          '</span>' +
        '</div>' +
        '<div id="boardHeat" style="overflow-x:auto"></div>' +
      '</div>' +

      '<div class="section-title">设备异常（故障 / 维护中）</div>' +
      (faultEqs.length
        ? '<div class="cab-wall">' + faultEqs.slice(0, 60).map(x =>
            '<div class="cab-mini" data-goto-eq="' + Util.esc(x.eq.station + '|' + x.eq.id) + '">' +
              '<div class="nm">' +
                '<span class="badge ' + (x.st === 'fault' ? 'b-fault' : 'b-maint') + '">' +
                  L.eqState(x.st) + '</span>' + Util.esc(x.eq.id) + '</div>' +
              '<div class="sub">' + Util.esc(x.eq.station) +
                (x.eq.cabinetId ? ' · ' + Util.esc(x.eq.cabinetId) : '') + '</div>' +
            '</div>').join('') + '</div>' +
          (faultEqs.length > 60 ? '<div class="hint">仅显示前 60 台，共 ' + faultEqs.length + ' 台</div>' : '')
        : '<div class="empty-tip">所有设备状态正常</div>') +

      '<div class="section-title">报错类型 TOP</div>' +
      errTop(App.error || []) +

      '<div class="section-title">近 7 日报错趋势</div>' +
      Charts.line(last7(App.error || []), { color: 'var(--warn)' }) +

      '<div class="section-title">现场建议</div>' +
      (Capacity.advice(cfg).map(a =>
        '<div class="suggest-card ' + (a.level === 'warn' ? 'warn' : '') + '">' +
        a.text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + '</div>').join('') ||
        '<div class="empty-tip">暂无建议</div>')
    );

  }

  /* 热力图改为按需绘制：默认不画，点按钮才画 */
  let _heatDrawn = false;

  function kpi(label, value, sub, color) {
    return '<div class="card"><div class="lbl">' + Util.esc(label) + '</div>' +
      '<div class="val" style="color:' + (color || 'var(--tx)') + '">' + value + '</div>' +
      (sub ? '<div class="sub">' + Util.esc(sub) + '</div>' : '') + '</div>';
  }

  function errTop(list) {
    if (!list.length) return '<div class="empty-tip">暂无报错</div>';
    const by = {};
    list.forEach(e => { by[e.type || '未分类'] = (by[e.type || '未分类'] || 0) + (e.count || 1); });
    return DataTable.build([
      { key: 'type', label: '报错类型' },
      { key: 'count', label: '累计次数', cls: 'num' },
      { key: 'bar', label: '占比', html: (v, r) =>
        DataTable.miniBar(r.count / (by[Object.keys(by)[0]] || 1), 'var(--bad)') }
    ], Object.keys(by).sort((a, b) => by[b] - by[a]).slice(0, 10)
      .map(k => ({ type: k, count: by[k] })));
  }

  function last7(list) {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = Util.todayKey(d);
      out.push({ label: key.slice(5),
        value: list.filter(e => e.day === key).reduce((a, e) => a + (e.count || 1), 0) });
    }
    return out;
  }

  /* 用 canvas 画全线热力图 */
  function drawHeat() {
    const box = document.getElementById('boardHeat');
    if (!box) return;
    _heatDrawn = true;
    const cfg = App.cfg;
    const topo = Topology.all(cfg);
    /* 按工站顺序把全部设备拉平，每格一个盘位 */
    const all = [];
    Topology.effectiveStations(cfg).forEach(s => {
      (topo.stationsMap[s.key] || []).forEach(eq => all.push(eq));
    });
    const canvas = document.createElement('canvas');
    box.innerHTML = '';
    box.appendChild(canvas);
    SlotGrid.drawCanvas(canvas, null, all, App.slots, { cell: 4, gap: 1, cols: 160 });
  }

  function bind() {
    Dom.delegate('boardBody', 'click', '#boardGotoFloor', () => App.switchView('floor'));

    Dom.delegate('boardBody', 'click', '#boardHeatToggle', (e, el) => {
      if (_heatDrawn) {
        Dom.html('boardHeat', '');
        _heatDrawn = false;
        el.textContent = '绘制热力图';
      } else {
        const t = Date.now();
        drawHeat();
        el.textContent = '清除热力图';
        Toast.ok('已绘制 12,737 格，耗时 ' + (Date.now() - t) + 'ms');
      }
    });

    Dom.delegate('boardBody', 'click', '[data-goto-eq]', (e, el) => {
      const p = el.dataset.gotoEq.split('|');
      LocalStore.ui.set('stationFilter', p[0]);
      App.switchView('floor');
      setTimeout(() => {
        const node = document.querySelector('#floorBody [data-eq="' + p[1] + '"]');
        if (node) Dom.scrollTo(node, 3000);
      }, 120);
    });
  }

  return { render, bind };
})();
