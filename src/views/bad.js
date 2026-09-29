/* ============================================================================
   不良记录 —— 以产品（内存/SSD）为主体的异常
   ----------------------------------------------------------------------------
   三个页签：全部 / 待确认 / 已确认
   待确认队列是判定引擎的出口：规则未命中的内容落到这里等人工处置。
   ============================================================================ */

const ViewBad = (() => {

  let _page = 1;

  async function render() {
    await App.ensureRecords('bad');
    const all = App.bad || [];
    const filter = LocalStore.ui.get('badFilter', 'all');
    const list = filter === 'pending' ? all.filter(b => !b.confirmed)
               : filter === 'confirmed' ? all.filter(b => b.confirmed)
               : all;

    /* 按类型汇总 */
    const byType = {};
    all.forEach(b => { byType[b.type || '未分类'] = (byType[b.type || '未分类'] || 0) + 1; });
    const typeItems = Object.keys(byType).sort((a, b) => byType[b] - byType[a])
      .map(k => ({ label: k, value: byType[k], color: 'var(--bad)' }));

    /* 按工站汇总 */
    const byStation = {};
    all.forEach(b => { byStation[b.station || '未知'] = (byStation[b.station || '未知'] || 0) + 1; });

    const pendingCount = all.filter(b => !b.confirmed).length;

    const cols = [
      { key: 'sel', label: '<input type="checkbox" id="badSelectAll">', width: '34px',
        html: (v, row) => row.confirmed ? ''
          : '<input type="checkbox" data-bad-select="' + row.id + '">' },
      { key: 'time', label: '时间', fmt: v => Util.fmtFull(v) },
      { key: 'station', label: '工站' },
      { key: 'cabinetId', label: '机柜', fmt: v => v || '--' },
      { key: 'serverId', label: '设备', fmt: v => v || '--' },
      { key: 'slotIndex', label: '位号', fmt: v => v == null ? '--' : ('位' + (v + 1)) },
      { key: 'sn', label: 'SN', cls: 'col-sn' },
      { key: 'pn', label: 'PN' },
      { key: 'type', label: '不良类型' },
      { key: 'errCode', label: '错误码', html: v => v
          ? '<span style="color:#ff8b82">' + Util.esc(v) + '</span>' : '--' },
      { key: 'verdict', label: '判定', html: v =>
          '<span class="pill ' + (v === 'functional' ? 'p-fail' : v === 'nonfunctional' ? 'p-wait' : 'p-warn') +
          '">' + Util.esc(L.verdict(v)) + '</span>' },
      { key: 'confirmed', label: '状态', html: (v, row) => v
          ? '<span class="pill p-pass">已确认</span>'
          : '<span class="pill p-wait">待确认</span>' },
      { key: 'act', label: '操作', html: (v, row) =>
          '<button class="btn xs" data-bad-trace="' + Util.esc(row.sn) + '">追溯</button>' +
          (row.confirmed ? '' :
            '<button class="btn xs" data-bad-confirm="' + row.id + '" style="margin-left:4px">确认</button>') }
    ];

    const sorted = list.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
    const pg = DataTable.paginated(cols, sorted, _page);

    Dom.html('badBody',
      '<div class="toolbar">' +
        '<button class="btn ' + (filter === 'all' ? 'on' : '') + '" data-bad-filter="all">' +
          '全部 ' + all.length + '</button>' +
        '<button class="btn ' + (filter === 'pending' ? 'on' : '') + '" data-bad-filter="pending">' +
          '待确认 ' + pendingCount + '</button>' +
        '<button class="btn ' + (filter === 'confirmed' ? 'on' : '') + '" data-bad-filter="confirmed">' +
          '已确认 ' + (all.length - pendingCount) + '</button>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn" id="btnDefectRules">不良判定设置</button>' +
        '<button class="btn primary" id="btnBadBatchConfirm"' +
          (pendingCount ? '' : ' disabled') + '>批量确认</button>' +
        '<button class="btn" id="btnBadExport">导出 CSV</button>' +
        '<button class="btn" id="btnBadNew">记录不良</button>' +
      '</div>' +

      '<div class="cards">' +
        '<div class="card"><div class="lbl">不良总数</div>' +
          '<div class="val" style="color:var(--bad)">' + Util.num(all.length) + '</div></div>' +
        '<div class="card"><div class="lbl">待确认</div>' +
          '<div class="val" style="color:var(--warn)">' + Util.num(pendingCount) + '</div>' +
          '<div class="sub">规则未命中，等待人工判定</div></div>' +
        '<div class="card"><div class="lbl">已确认</div>' +
          '<div class="val" style="color:var(--ok)">' + Util.num(all.length - pendingCount) + '</div></div>' +
      '</div>' +

      (pendingCount
        ? '<div class="note warn">有 <b>' + pendingCount + '</b> 条不良未命中任何判定规则，' +
          '已进入待确认队列。可在「不良判定设置」里用样本文本试判定，' +
          '再补充关键词或错误码规则 —— 规则变更<b>只影响后续判定，不重算历史</b>。</div>'
        : '') +

      '<div class="section-title">按不良类型</div>' +
      (typeItems.length ? DataTable.summaryList(typeItems) : '<div class="empty-tip">暂无数据</div>') +

      '<div class="section-title">按工站</div>' +
      (Object.keys(byStation).length
        ? DataTable.summaryList(Object.keys(byStation).map(k => ({
            label: k, value: byStation[k], color: 'var(--warn)'
          })))
        : '<div class="empty-tip">暂无数据</div>') +

      '<div class="section-title">明细' + (filter !== 'all' ? '（' +
        (filter === 'pending' ? '待确认' : '已确认') + '）' : '') + '</div>' +
      pg.html
    );
    _page = pg.page;
  }

  /* 批量确认选中的待确认不良 */
  async function batchConfirm() {
    const ids = Dom.$$('[data-bad-select]:checked').map(x => x.dataset.badSelect);
    if (!ids.length) { Toast.warn('请先勾选待确认的记录'); return; }

    const by = await Modal.prompt({
      title: '批量确认不良',
      text: '请输入确认人姓名',
      value: LocalStore.get('lastOperator', '') || '',
      hint: '将确认 ' + ids.length + ' 条记录，确认动作会记入判定流水（含确认人与时间）。'
    });
    if (by == null) return;
    LocalStore.set('lastOperator', by);

    const n = await DefectEngine.confirm(ids, by, '批量确认', App.defectDeps());
    App.invalidate('bad');
    await App.ensureRecords('bad');
    render();
    Toast.ok('已确认 ' + n + ' 条');
  }

  async function confirmOne(id) {
    const by = await Modal.prompt({
      title: '确认不良', text: '请输入确认人姓名',
      value: LocalStore.get('lastOperator', '')
    });
    if (by == null) return;
    LocalStore.set('lastOperator', by);
    await DefectEngine.confirm([id], by, '', App.defectDeps());
    App.invalidate('bad');
    await App.ensureRecords('bad');
    render();
    Toast.ok('已确认');
  }

  function exportCsv() {
    const list = (App.bad || []).slice().sort((a, b) => (b.time || 0) - (a.time || 0));
    if (!list.length) { Toast.warn('暂无数据'); return; }
    const rows = list.map(b => [
      b.day, b.time ? Util.fmtFull(b.time) : '', b.station, b.cabinetId, b.serverId,
      b.slotIndex == null ? '' : (b.slotIndex + 1), b.sn, b.pn, b.model, b.woNo,
      b.type, b.errCode, L.verdict(b.verdict), b.confirmed ? '已确认' : '待确认',
      b.confirmedBy, b.confirmedAt ? Util.fmtFull(b.confirmedAt) : '', b.source, b.note
    ]);
    Util.download('不良记录_' + Util.tsTag() + '.csv', Util.toCsv(
      ['日期', '时间', '工站', '机柜', '设备', '位号', 'SN', 'PN', '型号', '工单',
       '不良类型', '错误码', '判定', '状态', '确认人', '确认时间', '来源', '备注'], rows));
    Toast.ok('已导出 ' + rows.length + ' 条');
  }

  /* 手工记录一条不良 */
  async function openNew() {
    const stations = Topology.effectiveStations(App.cfg);
    Modal.open({
      title: '记录不良', size: 'normal',
      body:
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label">工站</label>' +
            '<select class="form-select" id="nbStation">' +
              stations.map(s => '<option value="' + s.key + '">' + s.name + ' · ' + s.cn + '</option>').join('') +
            '</select></div>' +
          '<div class="form-group"><label class="form-label">不良类型</label>' +
            '<select class="form-select" id="nbType">' +
              DEFECT_TYPES.map(t => '<option>' + Util.esc(t) + '</option>').join('') +
            '</select></div>' +
        '</div>' +
        '<div class="form-row" style="margin-top:11px">' +
          '<div class="form-group"><label class="form-label">SN<span class="req">*</span></label>' +
            '<input class="form-input" id="nbSn" placeholder="产品序列号"></div>' +
          '<div class="form-group"><label class="form-label">PN</label>' +
            '<input class="form-input" id="nbPn"></div>' +
        '</div>' +
        '<div class="form-row" style="margin-top:11px">' +
          '<div class="form-group"><label class="form-label">错误码</label>' +
            '<input class="form-input" id="nbCode" placeholder="如 E-ESS-220"></div>' +
          '<div class="form-group"><label class="form-label">工单号</label>' +
            '<input class="form-input" id="nbWo"></div>' +
        '</div>' +
        '<div class="form-group" style="margin-top:11px">' +
          '<label class="form-label">备注 / 原始描述</label>' +
          '<textarea class="form-textarea" id="nbNote" placeholder="粘贴原始报错文本，判定引擎会据此匹配规则"></textarea>' +
        '</div>' +
        '<div class="note" style="margin-top:12px">保存时会走判定引擎：' +
          '命中规则则按规则结论归类，未命中则进入<b>待确认</b>队列并留下判定流水。</div>',
      footer: '<button class="btn" data-mclose="1">取消</button>' +
              '<button class="btn primary" id="nbSave">保存</button>',
      onMount(h) {
        h.el.addEventListener('click', async e => {
          if (!e.target.closest('#nbSave')) return;
          const sn = h.query('#nbSn').value.trim();
          if (!sn) { Toast.warn('SN 必填'); return; }
          const station = h.query('#nbStation').value;
          const code = h.query('#nbCode').value.trim() || ErrCodeRules.extract(h.query('#nbNote').value);
          const ctx = {
            source: 'manual', station, sn,
            pn: h.query('#nbPn').value.trim(),
            woNo: h.query('#nbWo').value.trim(),
            errCode: code,
            rawText: h.query('#nbNote').value.trim() || h.query('#nbType').value,
            note: h.query('#nbNote').value.trim(),
            time: Date.now()
          };
          const r = await DefectEngine.record(ctx, App.defectDeps());
          App.invalidate('bad');
          await App.ensureRecords('bad');
          h.close();
          render();
          Toast.ok('已记录 · 判定：' + L.verdict(r.verdict) +
                   (r.ruleId ? '（命中规则）' : '（未命中，进入待确认）'));
        });
      }
    });
  }

  function bind() {
    Dom.delegate('badBody', 'click', '[data-bad-filter]', (e, el) => {
      LocalStore.ui.set('badFilter', el.dataset.badFilter);
      _page = 1;
      render();
    });
    Dom.delegate('badBody', 'click', '[data-bad-confirm]', (e, el) => confirmOne(el.dataset.badConfirm));
    Dom.delegate('badBody', 'click', '[data-bad-trace]', (e, el) => {
      LocalStore.ui.set('traceQuery', el.dataset.badTrace);
      App.switchView('trace');
    });
    Dom.delegate('badBody', 'change', '#badSelectAll', (e, el) => {
      Dom.$$('[data-bad-select]').forEach(x => { x.checked = el.checked; });
    });
    Dom.delegate('badBody', 'click', '#btnBadBatchConfirm', batchConfirm);
    Dom.delegate('badBody', 'click', '#btnBadExport', exportCsv);
    Dom.delegate('badBody', 'click', '#btnBadNew', openNew);
    Dom.delegate('badBody', 'click', '#btnDefectRules', () => {
      if (typeof ModalDefectRules !== 'undefined') ModalDefectRules.open();
      else Toast.warn('不良判定设置将在阶段 2 提供');
    });
    Dom.delegate('badBody', 'click', '[data-pg]', (e, el) => {
      _page = DataTable.handlePage(el.dataset.pg, _page, (App.bad || []).length);
      render();
    });
  }

  return { render, bind };
})();
