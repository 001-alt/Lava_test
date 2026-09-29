/* ============================================================================
   报错记录 —— 以设备/机柜为主体的异常（区别于以产品为主体的不良记录）
   ----------------------------------------------------------------------------
   同一位置同类型同日期的报错会合并计数，避免连续巡检堆出成千上万条。
   ============================================================================ */

const ViewError = (() => {

  let _page = 1;
  let _filterHandled = 'all';

  async function render() {
    await App.ensureRecords('error');
    const all = App.error || [];
    const list = _filterHandled === 'open' ? all.filter(e => !e.handled)
               : _filterHandled === 'done' ? all.filter(e => e.handled)
               : all;

    const byType = {};
    all.forEach(e => { byType[e.type || '未分类'] = (byType[e.type || '未分类'] || 0) + 1; });
    const typeItems = Object.keys(byType).sort((a, b) => byType[b] - byType[a])
      .map(k => ({ label: k, value: byType[k], color: 'var(--warn)' }));

    const byCode = {};
    all.forEach(e => {
      const c = e.errCode || '(无错误码)';
      byCode[c] = (byCode[c] || 0) + (e.count || 1);
    });
    const codeRows = Object.keys(byCode).sort((a, b) => byCode[b] - byCode[a])
      .map(k => ({ code: k, count: byCode[k] }));

    const byCab = {};
    all.forEach(e => {
      const c = e.cabinetId || e.equipmentId || '(未知位置)';
      byCab[c] = (byCab[c] || 0) + (e.count || 1);
    });
    const cabItems = Object.keys(byCab).sort((a, b) => byCab[b] - byCab[a]).slice(0, 12)
      .map(k => ({ label: k, value: byCab[k], color: 'var(--abort)' }));

    const openCount = all.filter(e => !e.handled).length;

    const cols = [
      { key: 'time', label: '最近时间', fmt: v => Util.fmtFull(v) },
      { key: 'station', label: '工站' },
      { key: 'cabinetId', label: '机柜', fmt: v => v || '--' },
      { key: 'equipmentId', label: '设备', fmt: v => v || '--' },
      { key: 'type', label: '报错类型' },
      { key: 'message', label: '信息' },
      { key: 'errCode', label: '错误码', fmt: v => v || '--' },
      { key: 'count', label: '次数', cls: 'num', html: v =>
          v > 1 ? '<b style="color:#f5cd6b">' + v + '</b>' : v },
      { key: 'handled', label: '状态', html: v =>
          v ? '<span class="pill p-pass">已处理</span>' : '<span class="pill p-wait">待处理</span>' },
      { key: 'act', label: '操作', html: (v, row) =>
          (row.handled ? '' : '<button class="btn xs" data-err-handle="' + row.id + '">标记已处理</button>') }
    ];

    const sorted = list.slice().sort((a, b) => (b.lastTime || b.time || 0) - (a.lastTime || a.time || 0));
    const pg = DataTable.paginated(cols, sorted, _page);

    Dom.html('errorBody',
      '<div class="toolbar">' +
        '<button class="btn ' + (_filterHandled === 'all' ? 'on' : '') + '" data-err-filter="all">' +
          '全部 ' + all.length + '</button>' +
        '<button class="btn ' + (_filterHandled === 'open' ? 'on' : '') + '" data-err-filter="open">' +
          '待处理 ' + openCount + '</button>' +
        '<button class="btn ' + (_filterHandled === 'done' ? 'on' : '') + '" data-err-filter="done">' +
          '已处理 ' + (all.length - openCount) + '</button>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn" id="btnErrExport">导出 CSV</button>' +
        '<button class="btn" id="btnErrNew">记录报错</button>' +
      '</div>' +

      '<div class="cards">' +
        '<div class="card"><div class="lbl">报错条目</div>' +
          '<div class="val" style="color:var(--warn)">' + Util.num(all.length) + '</div></div>' +
        '<div class="card"><div class="lbl">累计次数</div>' +
          '<div class="val">' + Util.num(all.reduce((a, e) => a + (e.count || 1), 0)) + '</div>' +
          '<div class="sub">同一位置同类型同日合并计数</div></div>' +
        '<div class="card"><div class="lbl">待处理</div>' +
          '<div class="val" style="color:' + (openCount ? 'var(--bad)' : 'var(--ok)') + '">' +
          Util.num(openCount) + '</div></div>' +
        '<div class="card"><div class="lbl">涉及设备</div>' +
          '<div class="val">' + Util.num(Object.keys(byCab).length) + '</div></div>' +
      '</div>' +

      '<div class="section-title">错误码 TOP</div>' +
      (codeRows.length
        ? DataTable.build([
            { key: 'code', label: '错误码' },
            { key: 'count', label: '累计次数', cls: 'num' }
          ], codeRows.slice(0, 15), { emptyText: '暂无错误码' })
        : '<div class="empty-tip">暂无错误码（多数报错未携带错误码）</div>') +

      '<div class="section-title">报错类型分布</div>' +
      (typeItems.length ? DataTable.summaryList(typeItems) : '<div class="empty-tip">暂无数据</div>') +

      '<div class="section-title">报错集中的位置（TOP 12）</div>' +
      (cabItems.length ? DataTable.summaryList(cabItems) : '<div class="empty-tip">暂无数据</div>') +

      '<div class="section-title">明细</div>' + pg.html
    );
    _page = pg.page;
  }

  async function markHandled(id) {
    const list = App.error || [];
    const e = list.filter(x => x.id === id)[0];
    if (!e) return;
    e.handled = true;
    e.updatedAt = Date.now();
    await Repo.put('error', e);
    render();
    Toast.ok('已标记为已处理');
  }

  function exportCsv() {
    const list = (App.error || []).slice().sort((a, b) => (b.time || 0) - (a.time || 0));
    if (!list.length) { Toast.warn('暂无数据'); return; }
    const rows = list.map(e => [
      e.day, e.firstTime ? Util.fmtFull(e.firstTime) : '', e.lastTime ? Util.fmtFull(e.lastTime) : '',
      e.station, e.cabinetId, e.serverId, e.equipmentId, e.type, e.message, e.errCode,
      e.count, e.handled ? '已处理' : '待处理', e.sn, e.source
    ]);
    Util.download('报错记录_' + Util.tsTag() + '.csv', Util.toCsv(
      ['日期', '首次时间', '最近时间', '工站', '机柜', '设备', '设备ID', '报错类型',
       '信息', '错误码', '次数', '状态', 'SN', '来源'], rows));
    Toast.ok('已导出 ' + rows.length + ' 条');
  }

  async function openNew() {
    const stations = Topology.effectiveStations(App.cfg);
    Modal.open({
      title: '记录报错', size: 'normal',
      body:
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label">工站</label>' +
            '<select class="form-select" id="neStation">' +
              stations.map(s => '<option value="' + s.key + '">' + s.name + ' · ' + s.cn + '</option>').join('') +
            '</select></div>' +
          '<div class="form-group"><label class="form-label">报错类型</label>' +
            '<select class="form-select" id="neType">' +
              ERROR_TYPES.map(t => '<option>' + Util.esc(t) + '</option>').join('') +
            '</select></div>' +
        '</div>' +
        '<div class="form-row" style="margin-top:11px">' +
          '<div class="form-group"><label class="form-label">机柜号</label>' +
            '<input class="form-input" id="neCab" placeholder="如 CAB-N-01"></div>' +
          '<div class="form-group"><label class="form-label">设备号</label>' +
            '<input class="form-input" id="neEq" placeholder="如 SRV-N-001 / OVEN-B-01"></div>' +
        '</div>' +
        '<div class="form-group" style="margin-top:11px">' +
          '<label class="form-label">报错信息</label>' +
          '<textarea class="form-textarea" id="neMsg" placeholder="设备侧原始报错文本"></textarea>' +
        '</div>' +
        '<div class="form-group" style="margin-top:11px">' +
          '<label class="form-label">错误码</label>' +
          '<input class="form-input" id="neCode" placeholder="留空则自动从信息中提取">' +
          '<div class="form-hint">已知错误码会自动带出处置策略（是否允许复测、是否锁定 SN）</div>' +
        '</div>' +
        '<div id="neCodeHint"></div>',
      footer: '<button class="btn" data-mclose="1">取消</button>' +
              '<button class="btn primary" id="neSave">保存</button>',
      onMount(h) {
        const codeEl = h.query('#neCode');
        const msgEl = h.query('#neMsg');
        const updHint = () => {
          const c = codeEl.value.trim() || ErrCodeRules.extract(msgEl.value);
          const r = c ? ErrCodeRules.find(App.cfg, c) : null;
          h.query('#neCodeHint').innerHTML = c
            ? (r
              ? '<div class="note">识别到 <b>' + Util.esc(r.code) + ' ' + Util.esc(r.name) + '</b><br>' +
                '处置：' + Util.esc(r.action || '--') + '<br>' +
                '允许复测：' + (r.allowRetest ? '<b style="color:#6ee787">是</b>' : '否') +
                ' · 锁定 SN：' + (r.lockSn ? '<b style="color:#ff8b82">是</b>' : '否') + '</div>'
              : '<div class="note warn">未识别的错误码，将按人工判定处理</div>')
            : '';
        };
        codeEl.addEventListener('input', updHint);
        msgEl.addEventListener('input', updHint);

        h.el.addEventListener('click', async e => {
          if (!e.target.closest('#neSave')) return;
          const msg = msgEl.value.trim();
          if (!msg) { Toast.warn('报错信息必填'); return; }
          const code = codeEl.value.trim() || ErrCodeRules.extract(msg);
          const rec = Schema.newError({
            station: h.query('#neStation').value,
            type: h.query('#neType').value,
            cabinetId: h.query('#neCab').value.trim(),
            equipmentId: h.query('#neEq').value.trim(),
            message: msg, errCode: code,
            source: 'manual', time: Date.now()
          });
          // 同位置同类型同日期合并
          const dup = (App.error || []).filter(x =>
            !x.handled && x.type === rec.type && x.day === rec.day &&
            x.equipmentId === rec.equipmentId && x.cabinetId === rec.cabinetId)[0];
          if (dup) {
            dup.count = (dup.count || 1) + 1;
            dup.lastTime = Date.now();
            dup.message = msg;
            if (code) dup.errCode = code;
            await Repo.put('error', dup);
          } else {
            await Repo.put('error', rec);
          }
          App.invalidate('error');
          await App.ensureRecords('error');
          h.close();
          render();
          Toast.ok(dup ? '已合并到同类报错（次数 +1）' : '已记录报错');
        });
      }
    });
  }

  function bind() {
    Dom.delegate('errorBody', 'click', '[data-err-filter]', (e, el) => {
      _filterHandled = el.dataset.errFilter; _page = 1; render();
    });
    Dom.delegate('errorBody', 'click', '[data-err-handle]', (e, el) => markHandled(el.dataset.errHandle));
    Dom.delegate('errorBody', 'click', '#btnErrExport', exportCsv);
    Dom.delegate('errorBody', 'click', '#btnErrNew', openNew);
    Dom.delegate('errorBody', 'click', '[data-pg]', (e, el) => {
      _page = DataTable.handlePage(el.dataset.pg, _page, (App.error || []).length);
      render();
    });
  }

  return { render, bind };
})();
