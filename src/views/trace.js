/* ============================================================================
   追溯查询 —— 按 SN / 工单 / 机柜 多维检索 + 时间线 + 连带追溯
   ============================================================================ */

const ViewTrace = (() => {

  async function render() {
    await App.ensureRecords('records');
    const q = LocalStore.ui.get('traceQuery', '');
    const chips = Trace.quickChips({ bad: App.bad || [], error: App.error || [] }, 6);

    const html =
      '<div class="toolbar">' +
        '<input class="form-input" id="traceInput" style="width:340px" ' +
          'placeholder="输入 SN / 工单号 / PN / 机柜号，回车查询" value="' + Util.esc(q) + '">' +
        '<button class="btn primary" id="btnTraceGo">查询</button>' +
        '<button class="btn" id="btnTraceClear">清空</button>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn" id="btnTraceExport">导出结果</button>' +
        '<button class="btn" id="btnBoxTrace">同箱/同柜追溯</button>' +
      '</div>' +
      (chips.length
        ? '<div class="chips-row">' +
            '<span style="font-size:11px;color:var(--tx-3);align-self:center">快捷：</span>' +
            chips.map(c => '<span class="chip-btn" data-trace-q="' + Util.esc(c.value) + '">' +
              Util.esc(c.label) + '<span class="cnt">' + c.count + '</span></span>').join('') +
          '</div>'
        : '') +
      '<div id="traceResult"></div>';

    Dom.html('traceBody', html);
    if (q) doSearch(q);
    else Dom.html('traceResult', '<div class="empty-tip">输入 SN 查看该产品的完整工序流转</div>');
  }

  function doSearch(q) {
    const box = document.getElementById('traceResult');
    if (!box) return;
    if (!q) { box.innerHTML = '<div class="empty-tip">请输入查询条件</div>'; return; }

    const r = Trace.search(q, {
      records: App.records || [],
      bad: App.bad || [],
      error: App.error || [],
      slots: Array.from(App.slots.values())
    });
    if (!r) { box.innerHTML = '<div class="empty-tip">请输入查询条件</div>'; return; }

    if (!r.summary.records && !r.summary.bads && !r.summary.errs && !r.summary.slots) {
      box.innerHTML = '<div class="empty-tip">未找到匹配记录：' + Util.esc(q) + '</div>';
      return;
    }

    /* 命中摘要 */
    const cards = '<div class="cards">' +
      card('测试记录', r.summary.records, 'var(--info)') +
      card('不良记录', r.summary.bads, 'var(--bad)') +
      card('报错记录', r.summary.errs, 'var(--warn)') +
      card('在制盘位', r.summary.slots, 'var(--ok)') +
      card('涉及 SN', r.summary.sns, 'var(--tx)') +
    '</div>';

    /* 单 SN 时直接给完整流转链 */
    let flowHtml = '';
    const snHit = Object.keys(r.snCount).sort((a, b) => r.snCount[b] - r.snCount[a]);
    if (snHit.length === 1) {
      const t = Trace.bySn(snHit[0], r.records);
      flowHtml = '<div class="section-title">完整工序流转 · ' + Util.esc(snHit[0]) + '</div>' +
        Timeline.flow(t.chain);
    } else if (snHit.length > 1 && snHit.length <= 12) {
      flowHtml = '<div class="section-title">命中产品（' + snHit.length + ' 块）</div>' +
        '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>SN</th><th class="num">记录数</th><th>当前进度</th><th></th></tr></thead><tbody>' +
        snHit.map(sn => {
          const t = Trace.bySn(sn, r.records);
          const done = t.chain.filter(c => c.state === 'pass').length;
          const hasFail = t.hasFail;
          return '<tr><td class="col-sn">' + Util.esc(sn) + '</td>' +
            '<td class="num">' + r.snCount[sn] + '</td>' +
            '<td>' + done + '/7 站' +
              (hasFail ? ' <span class="pill p-fail">有失败</span>' : '') + '</td>' +
            '<td><button class="btn xs" data-flow-sn="' + Util.esc(sn) + '">流转</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    /* 时间线 */
    const tl = '<div class="section-title">时间线<span class="note-inline">按时间倒序，最多 60 条</span></div>' +
      Timeline.events(r.timeline, { limit: 60 });

    /* 明细表 */
    const recCols = [
      { key: 'time', label: '时间', fmt: v => Util.fmtFull(v) },
      { key: 'station', label: '工站' },
      { key: 'cabinetId', label: '机柜' },
      { key: 'serverId', label: '设备' },
      { key: 'slotIndex', label: '位号', fmt: v => v == null ? '--' : ('位' + (v + 1)) },
      { key: 'sn', label: 'SN', cls: 'col-sn' },
      { key: 'pn', label: 'PN' },
      { key: 'result', label: '结果', html: v =>
        '<span class="pill ' + L.resultPill(v) + '">' + Util.esc(L.result(v)) + '</span>' },
      { key: 'errCode', label: '错误码', fmt: v => v || '--' }
    ];

    const badCols = [
      { key: 'time', label: '时间', fmt: v => Util.fmtFull(v) },
      { key: 'station', label: '工站' },
      { key: 'sn', label: 'SN', cls: 'col-sn' },
      { key: 'type', label: '不良类型' },
      { key: 'errCode', label: '错误码' },
      { key: 'verdict', label: '判定', html: v =>
        '<span class="pill ' + (v === 'functional' ? 'p-fail' : v === 'nonfunctional' ? 'p-wait' : 'p-warn') +
        '">' + Util.esc(L.verdict(v)) + '</span>' },
      { key: 'confirmed', label: '状态', html: v =>
        v ? '<span class="pill p-pass">已确认</span>' : '<span class="pill p-wait">待确认</span>' }
    ];

    const errCols = [
      { key: 'time', label: '时间', fmt: v => Util.fmtFull(v) },
      { key: 'station', label: '工站' },
      { key: 'equipmentId', label: '设备' },
      { key: 'type', label: '报错类型' },
      { key: 'message', label: '信息' },
      { key: 'count', label: '次数', cls: 'num' }
    ];

    box.innerHTML = cards + flowHtml +
      tl +
      (r.records.length ? '<div class="section-title">测试记录（' + r.records.length + '）</div>' +
        DataTable.build(recCols, r.records.slice(0, 200)) : '') +
      (r.bads.length ? '<div class="section-title">不良记录（' + r.bads.length + '）</div>' +
        DataTable.build(badCols, r.bads.slice(0, 200)) : '') +
      (r.errs.length ? '<div class="section-title">报错记录（' + r.errs.length + '）</div>' +
        DataTable.build(errCols, r.errs.slice(0, 200)) : '');
  }

  function card(label, value, color) {
    return '<div class="card"><div class="lbl">' + label + '</div>' +
      '<div class="val" style="color:' + (color || 'var(--tx)') + '">' +
      Util.num(value) + '</div></div>';
  }

  /* 同箱 / 同柜连带追溯 —— Lava_test 特有：
     单箱 256 盘、单柜 144 盘，一次设备异常的影响面是数十至数百块盘 */
  async function openBoxTrace(presetSlotKey) {
    const input = await Modal.prompt({
      title: '同箱 / 同柜追溯',
      text: '输入盘位 key（格式 工站|设备号|位号，位号从 0 起）或设备号/机柜号',
      value: presetSlotKey || '',
      hint: '例：BIST|OVEN-B-01|0 → 该箱 256 盘位；' +
            'FINAL|SRV-N-001|5 → 该柜 144 盘位。' +
            '也可直接输入 OVEN-B-01 或 CAB-N-01。'
    });
    if (!input) return;

    await App.ensureRecords('records');
    const slots = Array.from(App.slots.values());
    let result = null;

    const q = input.trim();
    if (q.indexOf('|') >= 0) {
      // 盘位 key → 找同箱/同柜
      const loc = Topology.locate(App.cfg, q);
      if (!loc) { Toast.error('无法解析该盘位 key'); return; }
      const scope = loc.boxId ? 'box' : 'cabinet';
      if (scope === 'box') {
        result = Trace.byBox(loc.boxId, App.records, slots, null);
      } else {
        result = Trace.byCabinet(App.cfg, loc.cabinetId, App.records, slots);
      }
    } else if (/^(OVEN-B|ESS-E)-/i.test(q)) {
      result = Trace.byBox(q.toUpperCase(), App.records, slots, null);
    } else if (/^CAB-/i.test(q)) {
      result = Trace.byCabinet(App.cfg, q.toUpperCase(), App.records, slots);
    } else {
      Toast.error('无法识别的输入格式');
      return;
    }
    if (!result) { Toast.error('未找到对应的箱体或机柜'); return; }
    showBoxResult(result);
  }

  function showBoxResult(r) {
    const isBox = r.scope === 'box';
    const title = isBox ? ('箱体连带追溯 · ' + r.boxId) : ('机柜连带追溯 · ' + r.cabinetId);
    const counts = r.counts || { pass: 0, fail: 0, abort: 0, testing: 0, used: 0 };
    const y = Capacity.yieldOf(counts);

    const body =
      '<div class="note warn">' + Util.esc(r.impact) +
        (isBox ? '<br>箱体工况异常时应<b>整箱判废重测</b>，不能只挑不良块 —— ' +
                 '同箱其余产品经历了相同的异常应力。'
               : '<br>机柜内设备异常（掉线/断电）时，需评估是否整柜复测。') +
      '</div>' +
      '<div class="cards">' +
        '<div class="card"><div class="lbl">在制产品</div><div class="val">' +
          Util.num(r.slotCount) + '</div>' +
          '<div class="sub">' + (isBox ? '箱容量 ' + (r.capacity || '--') : '柜容量 ' + r.slotCapacity) +
          '</div></div>' +
        '<div class="card"><div class="lbl">通过</div><div class="val" style="color:var(--ok)">' +
          Util.num(counts.pass) + '</div></div>' +
        '<div class="card"><div class="lbl">失败</div><div class="val" style="color:var(--bad)">' +
          Util.num(counts.fail) + '</div></div>' +
        '<div class="card"><div class="lbl">异常终止</div><div class="val" style="color:var(--abort)">' +
          Util.num(counts.abort) + '</div><div class="sub">不计入良率</div></div>' +
        '<div class="card"><div class="lbl">良率</div><div class="val">' +
          (y.pct == null ? '--' : (y.pct * 100).toFixed(1) + '%') + '</div>' +
          '<div class="sub">' + y.formula + '</div></div>' +
      '</div>' +
      (isBox ? '' :
        '<div class="section-title">各服务器明细</div>' +
        DataTable.build([
          { key: 'id', label: '服务器' },
          { key: 'capacity', label: '容量', cls: 'num' },
          { key: 'used', label: '在制', cls: 'num' },
          { key: 'counts', label: '通过/失败/异常', fmt: v =>
            (v.pass || 0) + ' / ' + (v.fail || 0) + ' / ' + (v.abort || 0) }
        ], r.servers || [])) +
      '<div class="section-title">牵连产品 SN（前 200）</div>' +
      '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>SN</th><th></th></tr></thead><tbody>' +
      (r.sns || []).slice(0, 200).map(sn =>
        '<tr><td class="col-sn">' + Util.esc(sn) + '</td>' +
        '<td><button class="btn xs" data-flow-sn="' + Util.esc(sn) + '">流转</button></td></tr>'
      ).join('') + '</tbody></table></div>';

    Modal.open({
      title, size: 'wide', body,
      footer: '<button class="btn" data-mclose="1">关闭</button>' +
              '<button class="btn primary" data-export-box="1">导出该' + (isBox ? '箱' : '柜') + '清单</button>',
      onMount(h) {
        h.el.addEventListener('click', e => {
          const fs = e.target.closest('[data-flow-sn]');
          if (fs) { h.close(); showSingleSn(fs.dataset.flowSn); return; }
          if (e.target.closest('[data-export-box]')) {
            const rows = (r.records || []).map(x => [x.time ? Util.fmtFull(x.time) : '', x.station,
              x.cabinetId, x.serverId, x.slotIndex, x.sn, x.result, x.errCode]);
            Util.download((isBox ? r.boxId : r.cabinetId) + '_连带追溯_' + Util.tsTag() + '.csv',
              Util.toCsv(['时间', '工站', '机柜', '设备', '位号', 'SN', '结果', '错误码'], rows));
            Toast.ok('已导出');
          }
        });
      }
    });
  }

  /* 单 SN 流转（弹窗） */
  async function showSingleSn(sn) {
    await App.ensureRecords('records');
    const recs = (App.records || []).filter(r => r.sn === sn);
    const t = Trace.bySn(sn, recs);
    const slot = Array.from(App.slots.values()).filter(s => s.sn === sn)[0];
    const loc = slot ? Topology.locate(App.cfg, slot.key) : null;

    Modal.open({
      title: sn,
      sub: (t.pn || '') + (t.woNo ? ' · ' + t.woNo : ''),
      size: 'normal',
      body:
        (loc ? '<div class="hint">当前位置：' + Util.esc(loc.label) + '</div>' : '') +
        Timeline.flow(t.chain) +
        (t.retestHint ? '' : '') +
        (t.records.length ? '' :
          '<div class="note warn">该 SN 暂无测试记录，上图为按当前位置推断的进度。</div>'),
      footer: '<button class="btn" data-mclose="1">关闭</button>'
    });
  }

  function bind() {
    Dom.delegate('traceBody', 'click', '#btnTraceGo', () => {
      const v = (document.getElementById('traceInput').value || '').trim();
      LocalStore.ui.set('traceQuery', v);
      doSearch(v);
    });
    Dom.delegate('traceBody', 'keydown', '#traceInput', (e) => {
      if (e.key === 'Enter') {
        const v = (e.target.value || '').trim();
        LocalStore.ui.set('traceQuery', v);
        doSearch(v);
      }
    });
    Dom.delegate('traceBody', 'click', '#btnTraceClear', () => {
      document.getElementById('traceInput').value = '';
      LocalStore.ui.set('traceQuery', '');
      doSearch('');
    });
    Dom.delegate('traceBody', 'click', '[data-trace-q]', (e, el) => {
      const v = el.dataset.traceQ;
      document.getElementById('traceInput').value = v;
      LocalStore.ui.set('traceQuery', v);
      doSearch(v);
    });
    Dom.delegate('traceBody', 'click', '[data-flow-sn]', (e, el) => showSingleSn(el.dataset.flowSn));
    Dom.delegate('traceBody', 'click', '#btnBoxTrace', () => openBoxTrace(''));
    Dom.delegate('traceBody', 'click', '#btnTraceExport', () => {
      const q = LocalStore.ui.get('traceQuery', '');
      if (!q) { Toast.warn('请先查询'); return; }
      const r = Trace.search(q, {
        records: App.records || [], bad: App.bad || [],
        error: App.error || [], slots: Array.from(App.slots.values())
      });
      if (!r || !r.records.length) { Toast.warn('无测试记录可导出'); return; }
      const rows = r.records.map(x => [x.time ? Util.fmtFull(x.time) : '', x.station,
        x.cabinetId, x.serverId, x.slotIndex, x.sn, x.pn, x.result, x.errCode]);
      Util.download('追溯_' + q.replace(/[^\w-]/g, '_') + '_' + Util.tsTag() + '.csv',
        Util.toCsv(['时间', '工站', '机柜', '设备', '位号', 'SN', 'PN', '结果', '错误码'], rows));
      Toast.ok('已导出 ' + rows.length + ' 条');
    });
  }

  return { render, bind, doSearch, openBoxTrace };
})();
