/* ============================================================================
   当日报表 —— 按工站汇总当日生产情况，可展开看明细
   ============================================================================ */

const ViewDaily = (() => {

  function dayKey() {
    return LocalStore.ui.get('dailyDate', '') || Util.todayKey();
  }

  async function render() {
    await App.ensureRecords('records');
    const day = dayKey();
    const topo = Topology.all(App.cfg);
    const slots = App.slots;

    /* 当日记录（按日期字段过滤） */
    const recs = (App.records || []).filter(r => r.day === day);

    /* 逐工站汇总 */
    const rows = Topology.summary(App.cfg).map(s => {
      const eqs = topo.stationsMap[s.station] || [];
      const c = SlotGrid.countStates(eqs, slots);
      const dayRecs = recs.filter(r => r.station === s.station);
      const pass = dayRecs.filter(r => String(r.result).toUpperCase() === 'PASS').length;
      const fail = dayRecs.filter(r => String(r.result).toUpperCase() === 'FAIL').length;
      const abort = dayRecs.filter(r => String(r.result).toUpperCase() === 'ABORT').length;
      const y = Capacity.yieldOf({ pass, fail, abort });
      const bads = (App.bad || []).filter(b => b.day === day && b.station === s.station).length;
      const errs = (App.error || []).filter(e => e.day === day && e.station === s.station).length;
      return { s, c, dayRecs, pass, fail, abort, y, bads, errs };
    });

    const sumPass = rows.reduce((a, r) => a + r.pass, 0);
    const sumFail = rows.reduce((a, r) => a + r.fail, 0);
    const sumAbort = rows.reduce((a, r) => a + r.abort, 0);
    const sumYield = Capacity.yieldOf({ pass: sumPass, fail: sumFail, abort: sumAbort });
    const totalUsed = rows.reduce((a, r) => a + r.c.used, 0);

    const cols = [
      { key: 'st', label: '工序', html: (v, r) =>
          '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' +
          r.s.color + ';margin-right:7px"></span>' + r.s.name +
          (r.s.bypass ? ' <span class="pill p-wait">旁路</span>' : '') },
      { key: 'eq', label: '设备', fmt: (v, r) => r.s.eqCount + ' ' + r.s.unit +
          (r.s.cabCount ? ' / ' + r.s.cabCount + ' 柜' : '') },
      { key: 'cap', label: '单台容量', cls: 'num', fmt: (v, r) => r.s.capacityPerUnit },
      { key: 'online', label: '同时在线', cls: 'num', fmt: (v, r) => Util.num(r.s.online) },
      { key: 'cycle', label: '单轮', cls: 'num', fmt: (v, r) => Util.fmtCycle(r.s.cycleMin) },
      { key: 'used', label: '在制', cls: 'num', fmt: (v, r) => Util.num(r.c.used) },
      { key: 'testing', label: '在测', cls: 'num', fmt: (v, r) => Util.num(r.c.testing) },
      { key: 'pass', label: '通过', cls: 'num', html: (v, r) =>
          '<span style="color:#6ee787">' + Util.num(r.pass) + '</span>' },
      { key: 'fail', label: '失败', cls: 'num', html: (v, r) =>
          '<span style="color:#ff8b82">' + Util.num(r.fail) + '</span>' },
      { key: 'abort', label: '异常终止', cls: 'num', html: (v, r) =>
          '<span style="color:#b9aef5">' + Util.num(r.abort) + '</span>' },
      { key: 'yield', label: '良率', cls: 'num', fmt: (v, r) =>
          r.y.pct == null ? '--' : (r.y.pct * 100).toFixed(1) + '%' },
      { key: 'bad', label: '不良', cls: 'num' },
      { key: 'err', label: '报错', cls: 'num' },
      { key: 'util', label: '利用率', cls: 'num', html: (v, r) => DataTable.miniBar(r.c.util) }
    ];

    const bottom = {
      st: '合计', eq: '', cap: '', online: '', cycle: '',
      used: totalUsed, testing: rows.reduce((a, r) => a + r.c.testing, 0),
      pass: sumPass, fail: sumFail, abort: sumAbort,
      yield: sumYield.pct, bad: rows.reduce((a, r) => a + r.bads, 0),
      err: rows.reduce((a, r) => a + r.errs, 0), util: ''
    };

    const tableHtml = DataTable.build(cols, rows, {
      rowClass: (r) => r.s.isBottleneck ? 'total-row' : ''
    }).replace('</tbody>',
      '<tr class="total-row">' +
      '<td>合计</td><td></td><td class="num"></td><td class="num"></td><td class="num"></td>' +
      '<td class="num">' + Util.num(bottom.used) + '</td>' +
      '<td class="num">' + Util.num(bottom.testing) + '</td>' +
      '<td class="num"><span style="color:#6ee787">' + Util.num(sumPass) + '</span></td>' +
      '<td class="num"><span style="color:#ff8b82">' + Util.num(sumFail) + '</span></td>' +
      '<td class="num"><span style="color:#b9aef5">' + Util.num(sumAbort) + '</span></td>' +
      '<td class="num">' + (sumYield.pct == null ? '--' : (sumYield.pct * 100).toFixed(2) + '%') + '</td>' +
      '<td class="num">' + Util.num(bottom.bad) + '</td>' +
      '<td class="num">' + Util.num(bottom.err) + '</td>' +
      '<td></td></tr></tbody>');

    Dom.html('dailyBody',
      '<div class="toolbar">' +
        '<span class="title">' + day + ' 当日报表</span>' +
        '<input type="date" class="form-input" id="dailyDate" style="width:160px" value="' + day + '">' +
        '<button class="btn" id="dailyToday">今天</button>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn" id="dailyExport">导出 CSV</button>' +
      '</div>' +

      '<div class="cards">' +
        '<div class="card"><div class="lbl">当前在制</div><div class="val">' +
          Util.num(totalUsed) + '</div><div class="sub">全工序盘位占用</div></div>' +
        '<div class="card"><div class="lbl">当日判定</div><div class="val">' +
          Util.num(sumPass + sumFail) + '</div>' +
          '<div class="sub">PASS ' + Util.num(sumPass) + ' · FAIL ' + Util.num(sumFail) + '</div></div>' +
        '<div class="card accent"><div class="lbl">当日良率</div>' +
          '<div class="val" style="color:' +
            (sumYield.pct == null ? 'var(--tx-3)' : sumYield.pct >= 0.95 ? 'var(--ok)' : 'var(--warn)') + '">' +
            (sumYield.pct == null ? '--' : (sumYield.pct * 100).toFixed(2) + '%') + '</div>' +
          '<div class="sub">' + sumYield.formula + '</div></div>' +
        '<div class="card"><div class="lbl">异常终止</div>' +
          '<div class="val" style="color:var(--abort)">' + Util.num(sumAbort) + '</div>' +
          '<div class="sub">数据不完整，不计入良率分母</div></div>' +
      '</div>' +

      '<div class="note">' +
        '<b>良率口径</b>：' + sumYield.formula + '。<br>' +
        '⚠️ 「异常终止」是断电 / 超时 / 中途取料导致的<b>数据不完整</b>，不是产品不合格，' +
        '因此单列且不进入分母。这条口径本身尚未经现场确认（规范 §10），如与实际不符请告知。' +
      '</div>' +

      tableHtml +

      '<div class="section-title">各工站当日判定明细</div>' +
      (recs.length
        ? DataTable.build([
            { key: 'time', label: '时间', fmt: v => Util.fmtFull(v) },
            { key: 'station', label: '工站' },
            { key: 'cabinetId', label: '机柜' },
            { key: 'serverId', label: '设备' },
            { key: 'sn', label: 'SN', cls: 'col-sn' },
            { key: 'pn', label: 'PN' },
            { key: 'result', label: '结果', html: v =>
              '<span class="pill ' + L.resultPill(v) + '">' + Util.esc(L.result(v)) + '</span>' },
            { key: 'errCode', label: '错误码', fmt: v => v || '--' }
          ], recs.slice().sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 300),
          { emptyText: '当日无判定记录' })
        : '<div class="empty-tip">当日暂无测试记录。点击顶栏「生成模拟数据」可查看界面效果。</div>')
    );
  }

  function exportCsv() {
    const day = dayKey();
    const recs = (App.records || []).filter(r => r.day === day);
    const rows = recs.map(r => [
      r.day, r.time ? Util.fmtFull(r.time) : '', r.station, r.cabinetId, r.serverId,
      r.slotIndex == null ? '' : (r.slotIndex + 1), r.sn, r.pn, r.model, r.woNo,
      r.result, r.errCode, r.source
    ]);
    if (!rows.length) { Toast.warn('当日无记录可导出'); return; }
    Util.download('当日报表_' + day + '.csv', Util.toCsv(
      ['日期', '时间', '工站', '机柜', '设备', '位号', 'SN', 'PN', '型号', '工单',
       '结果', '错误码', '来源'], rows));
    Toast.ok('已导出 ' + rows.length + ' 条');
  }

  function bind() {
    Dom.delegate('dailyBody', 'change', '#dailyDate', (e, el) => {
      LocalStore.ui.set('dailyDate', el.value);
      render();
    });
    Dom.delegate('dailyBody', 'click', '#dailyToday', () => {
      LocalStore.ui.set('dailyDate', Util.todayKey());
      render();
    });
    Dom.delegate('dailyBody', 'click', '#dailyExport', exportCsv);
  }

  return { render, bind };
})();
