/* ============================================================================
   工单管理 —— 工序链进度、接单/开始/结单、结单归档
   ============================================================================ */

const ViewWo = (() => {

  async function render() {
    await App.ensureRecords('records');
    const list = App.workOrders || [];
    const sum = WorkOrder.summary(list);

    Dom.html('woBody',
      '<div class="toolbar">' +
        '<span class="title">工单管理</span>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn" id="btnWoExport">导出 CSV</button>' +
        '<button class="btn primary" id="btnWoNew">新建工单</button>' +
      '</div>' +

      '<div class="cards">' +
        '<div class="card"><div class="lbl">工单总数</div><div class="val">' +
          Util.num(sum.total) + '</div>' +
          '<div class="sub">合计 ' + Util.num(sum.qty) + ' 块</div></div>' +
        '<div class="card"><div class="lbl">待生产</div><div class="val">' + sum.wait + '</div></div>' +
        '<div class="card"><div class="lbl">已接单</div><div class="val">' + sum.accepted + '</div></div>' +
        '<div class="card accent"><div class="lbl">生产中</div>' +
          '<div class="val" style="color:var(--info)">' + sum.running + '</div></div>' +
        '<div class="card"><div class="lbl">已结单</div>' +
          '<div class="val" style="color:var(--ok)">' + sum.closed + '</div></div>' +
      '</div>' +

      (list.length
        ? list.map(woCard).join('')
        : '<div class="empty-tip">暂无工单。点击「新建工单」创建，' +
          '或到「实时拉取」从现场系统导入。</div>')
    );
  }

  function woCard(wo) {
    const recs = (App.records || []).filter(r => r.woId === wo.id);
    const actual = WorkOrder.actualOf(wo, recs);
    const prog = WorkOrder.progressOf(wo, actual);
    const chk = WorkOrder.checkClose(wo, actual, recs);
    const steps = WorkOrder.processWithOrt(wo.model || wo.pn);

    const stepHtml = steps.map(st => {
      const s = ST[st];
      const a = actual[st] || { tested: 0, pass: 0, fail: 0 };
      const need = (wo.plan || {})[st] || 0;
      const done = need > 0 && a.tested >= need;
      const active = !done && a.tested > 0;
      const isOrt = st === 'ORT';
      return '<div class="wo-step' + (done ? ' done' : active ? ' active' : '') + '"' +
          (isOrt ? ' style="opacity:.82"' : '') + '>' +
        '<div class="wo-step-name">' + Util.esc(s ? s.name : st) +
          (isOrt ? '<span style="font-size:9.5px;color:var(--tx-3)"> 旁路</span>' : '') + '</div>' +
        '<div class="wo-step-stat">' + Util.num(a.tested) + ' / ' + Util.num(need) + '</div>' +
        (a.fail ? '<div class="wo-step-stat" style="color:#ff8b82">FAIL ' + a.fail + '</div>' : '') +
      '</div>';
    }).join('');

    const canAccept = wo.status === 'wait';
    const canStart = wo.status === 'accepted' || wo.status === 'wait';
    const canClose = wo.status === 'running' || wo.status === 'accepted';
    const canReopen = wo.status === 'closed';

    return '<div class="wo-card" data-wo="' + Util.esc(wo.id) + '">' +
      '<div class="wo-card-head">' +
        '<span class="wo-no">' + Util.esc(wo.no) + '</span>' +
        '<span class="wo-badge ' + L.woPill(wo.status) + '">' + Util.esc(L.woState(wo.status)) + '</span>' +
        '<span style="font-size:11.5px;color:var(--tx-2)">' + Util.esc(wo.model || wo.pn) + '</span>' +
        (wo.customer ? '<span class="pill p-wait">' + Util.esc(wo.customer) + '</span>' : '') +
        '<span class="spacer" style="flex:1"></span>' +
        '<span style="font-size:11.5px;color:var(--tx-2)">' +
          Util.num(actual.__tested || recs.length) + ' / ' + Util.num(wo.qty) + ' 块</span>' +
      '</div>' +
      '<div class="wo-meta">' +
        'PN ' + Util.esc(wo.pn || '--') + ' · 数量 ' + Util.num(wo.qty) + ' · 创建 ' +
        Util.fmtFull(wo.createdAt) +
        (wo.acceptedBy ? ' · 接单 ' + Util.esc(wo.acceptedBy) : '') +
        (wo.closedAt ? ' · 结单 ' + Util.fmtFull(wo.closedAt) : '') +
      '</div>' +
      '<div class="wo-progress">' + stepHtml + '</div>' +
      '<div style="margin:8px 0 4px">' + DataTable.miniBar(prog) +
        '<span style="font-size:11px;color:var(--tx-3);margin-left:8px">工序完成度</span></div>' +
      (chk.ok
        ? '<div class="suggest-card ok" style="margin:8px 0">✓ 全部工序已完成，无未确认 FAIL，可以结单</div>'
        : '<div class="suggest-card warn" style="margin:8px 0">未满足结单条件：' +
          Util.esc(chk.issues.join('；')) + '</div>') +
      (chk.ortNote ? '<div class="hint" style="margin:0 0 6px">' + Util.esc(chk.ortNote) + '</div>' : '') +
      '<div class="wo-actions">' +
        (canAccept ? '<button class="btn sm" data-wo-accept="' + wo.id + '">接单</button>' : '') +
        (canStart ? '<button class="btn sm" data-wo-start="' + wo.id + '">开始生产</button>' : '') +
        (canClose ? '<button class="btn sm primary" data-wo-close="' + wo.id + '">结单</button>' : '') +
        (canReopen ? '<button class="btn sm warn" data-wo-reopen="' + wo.id + '">反结单</button>' : '') +
        '<button class="btn sm" data-wo-detail="' + wo.id + '">详情</button>' +
        '<span class="spacer" style="flex:1"></span>' +
        (wo.status === 'closed' ? '' : '<button class="btn sm danger" data-wo-del="' + wo.id + '">删除</button>') +
      '</div>' +
    '</div>';
  }

  async function save(list) {
    for (const wo of list) await Repo.put('workorders', wo);
    App.state.workOrders = list;
  }

  async function openNew() {
    const stations = Topology.effectiveStations(App.cfg);
    Modal.open({
      title: '新建工单', size: 'normal',
      body:
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label">工单号<span class="req">*</span></label>' +
            '<input class="form-input" id="woNo" placeholder="如 WO26092901"></div>' +
          '<div class="form-group"><label class="form-label">订单号</label>' +
            '<input class="form-input" id="woOrderNo"></div>' +
        '</div>' +
        '<div class="form-row" style="margin-top:11px">' +
          '<div class="form-group"><label class="form-label">PN<span class="req">*</span></label>' +
            '<input class="form-input" id="woPn" placeholder="如 LVA-SSD-1T92-B3"></div>' +
          '<div class="form-group"><label class="form-label">机型 / 系列</label>' +
            '<input class="form-input" id="woModel" placeholder="如 Lava 1.92T"></div>' +
        '</div>' +
        '<div class="form-row" style="margin-top:11px">' +
          '<div class="form-group"><label class="form-label">生产数量<span class="req">*</span></label>' +
            '<input type="number" class="form-input" id="woQty" min="1" value="1000"></div>' +
          '<div class="form-group"><label class="form-label">客户 / 备注</label>' +
            '<input class="form-input" id="woCustomer"></div>' +
        '</div>' +
        '<div class="note" style="margin-top:12px">' +
          '工序链按机型自动推导：<b>' + MAINLINE.join(' → ') + '</b>' +
          '（ORT 为旁路抽检，单独按 2.5% 计算抽样量）。<br>' +
          '计划数 = 批量；ORT 计划 = ⌈批量 × 2.5%⌉。</div>' +
        '<div id="woPlanPreview"></div>',
      footer: '<button class="btn" data-mclose="1">取消</button>' +
              '<button class="btn primary" id="woSave">创建</button>',
      onMount(h) {
        const qtyEl = h.query('#woQty');
        const upd = () => {
          const q = Number(qtyEl.value) || 0;
          const ort = Sampling.calc(q);
          h.query('#woPlanPreview').innerHTML = q > 0
            ? '<div class="note">计划预览：主线各站 ' + Util.num(q) + ' 块；' +
              'ORT 抽 <b>' + ort.sample + '</b> 块（' + ort.rounds + ' 台次）</div>' : '';
        };
        qtyEl.addEventListener('input', upd);
        upd();

        h.el.addEventListener('click', async e => {
          if (!e.target.closest('#woSave')) return;
          const wo = WorkOrder.create({
            no: h.query('#woNo').value.trim(),
            orderNo: h.query('#woOrderNo').value.trim(),
            pn: h.query('#woPn').value.trim(),
            model: h.query('#woModel').value.trim(),
            qty: Number(qtyEl.value) || 0,
            customer: h.query('#woCustomer').value.trim()
          });
          const v = WorkOrder.validate(wo, App.workOrders);
          if (!v.ok) { Toast.warn(v.errors.join('；')); return; }
          App.state.workOrders = (App.workOrders || []).concat([wo]);
          await save(App.state.workOrders);
          h.close();
          render();
          Toast.ok('工单 ' + wo.no + ' 已创建');
        });
      }
    });
  }

  async function openDetail(id) {
    const wo = (App.workOrders || []).filter(w => w.id === id)[0];
    if (!wo) return;
    const recs = (App.records || []).filter(r => r.woId === wo.id);
    const actual = WorkOrder.actualOf(wo, recs);
    const chk = WorkOrder.checkClose(wo, actual, recs);

    /* 按天统计 */
    const byDay = {};
    recs.forEach(r => {
      const d = byDay[r.day] = byDay[r.day] || { tested: 0, pass: 0, fail: 0 };
      d.tested++;
      const res = String(r.result).toUpperCase();
      if (res === 'PASS') d.pass++;
      else if (res === 'FAIL') d.fail++;
    });
    const dayRows = Object.keys(byDay).sort().map(d => Object.assign({ day: d }, byDay[d]));

    Modal.open({
      title: '工单详情 · ' + wo.no,
      sub: (wo.model || wo.pn) + ' · ' + Util.num(wo.qty) + ' 块 · ' + L.woState(wo.status),
      size: 'wide',
      body:
        '<div class="cards">' +
          '<div class="card"><div class="lbl">已测记录</div><div class="val">' +
            Util.num(recs.length) + '</div></div>' +
          '<div class="card"><div class="lbl">PASS</div>' +
            '<div class="val" style="color:var(--ok)">' +
            Util.num(recs.filter(r => String(r.result).toUpperCase() === 'PASS').length) + '</div></div>' +
          '<div class="card"><div class="lbl">FAIL</div>' +
            '<div class="val" style="color:var(--bad)">' +
            Util.num(recs.filter(r => String(r.result).toUpperCase() === 'FAIL').length) + '</div></div>' +
        '</div>' +
        '<div class="note ' + (chk.ok ? 'ok' : 'warn') + '">' +
          (chk.ok ? '✓ 可以结单' : '未满足结单条件：' + Util.esc(chk.issues.join('；'))) + '</div>' +
        '<div class="section-title">工序进度</div>' +
        DataTable.build([
          { key: 'st', label: '工序' },
          { key: 'plan', label: '计划', cls: 'num' },
          { key: 'tested', label: '已测', cls: 'num' },
          { key: 'pass', label: 'PASS', cls: 'num' },
          { key: 'fail', label: 'FAIL', cls: 'num' },
          { key: 'bar', label: '进度', html: (v, r) =>
            DataTable.miniBar(r.plan ? r.tested / r.plan : 0) }
        ], WorkOrder.processWithOrt(wo.model || wo.pn).map(st => {
          const a = actual[st] || { tested: 0, pass: 0, fail: 0 };
          return { st: st + ((wo.plan || {})[st] === undefined ? '（旁路）' : ''),
                   plan: (wo.plan || {})[st] || 0,
                   tested: a.tested, pass: a.pass, fail: a.fail };
        })) +
        '<div class="section-title">按日统计</div>' +
        (dayRows.length
          ? DataTable.build([
              { key: 'day', label: '日期' },
              { key: 'tested', label: '已测', cls: 'num' },
              { key: 'pass', label: 'PASS', cls: 'num' },
              { key: 'fail', label: 'FAIL', cls: 'num' }
            ], dayRows)
          : '<div class="empty-tip">暂无记录</div>') +
        '<div class="section-title">SN 明细（前 300 条）</div>' +
        (recs.length
          ? DataTable.build([
              { key: 'sn', label: 'SN', cls: 'col-sn' },
              { key: 'station', label: '工站' },
              { key: 'result', label: '结果', html: v =>
                '<span class="pill ' + L.resultPill(v) + '">' + Util.esc(L.result(v)) + '</span>' },
              { key: 'slotIndex', label: '位号', fmt: v => v == null ? '--' : ('位' + (v + 1)) },
              { key: 'time', label: '时间', fmt: v => Util.fmtFull(v) },
              { key: 'errCode', label: '错误码', fmt: v => v || '--' }
            ], recs.slice().sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 300))
          : '<div class="empty-tip">暂无记录</div>'),
      footer: '<button class="btn" data-mclose="1">关闭</button>',
      size: 'wide'
    });
  }

  async function closeWo(id) {
    const wo = (App.workOrders || []).filter(w => w.id === id)[0];
    if (!wo) return;
    const recs = (App.records || []).filter(r => r.woId === wo.id);
    const actual = WorkOrder.actualOf(wo, recs);
    const chk = WorkOrder.checkClose(wo, actual, recs);
    if (!chk.ok) {
      Toast.warn('不满足结单条件：' + chk.issues.join('；'), '无法结单');
      return;
    }
    const by = await Modal.prompt({
      title: '结单确认', text: '请输入结单确认人',
      value: LocalStore.get('lastOperator', ''),
      hint: '⚠️ 结单会把该工单涉及的盘位归档后复位（清空 SN/结果），' +
            '物理状态（损坏/维护）保留。这一步是破坏性操作，可用「反结单」撤销状态但不会恢复盘位数据。'
    });
    if (by == null) return;
    LocalStore.set('lastOperator', by);

    // 归档 + 复位
    const involved = Array.from(App.slots.values()).filter(s => s.woNo === wo.no);
    const arcs = WorkOrder.buildArchives(wo, involved);
    for (const a of arcs) await Repo.put('archives', a);
    if (involved.length) {
      const reset = WorkOrder.resetSlots(involved);
      await App.saveSlots(reset);
    }
    WorkOrder.close(wo, by, '');
    await save(App.workOrders);
    App.invalidate();
    await App.ensureRecords('records');
    render();
    Toast.ok('已结单，归档 ' + arcs.length + ' 组，复位 ' + involved.length + ' 个盘位');
  }

  function bind() {
    Dom.delegate('woBody', 'click', '[data-wo-accept]', async (e, el) => {
      const wo = (App.workOrders || []).filter(w => w.id === el.dataset.woAccept)[0];
      if (!wo) return;
      const by = await Modal.prompt({ title: '接单', text: '请输入接单人',
        value: LocalStore.get('lastOperator', '') });
      if (by == null) return;
      LocalStore.set('lastOperator', by);
      WorkOrder.accept(wo, by);
      await save(App.workOrders);
      render();
      Toast.ok('已接单');
    });

    Dom.delegate('woBody', 'click', '[data-wo-start]', async (e, el) => {
      const wo = (App.workOrders || []).filter(w => w.id === el.dataset.woStart)[0];
      if (!wo) return;
      WorkOrder.start(wo);
      await save(App.workOrders);
      render();
      Toast.ok('已开始生产');
    });

    Dom.delegate('woBody', 'click', '[data-wo-close]', (e, el) => closeWo(el.dataset.woClose));
    Dom.delegate('woBody', 'click', '[data-wo-detail]', (e, el) => openDetail(el.dataset.woDetail));

    Dom.delegate('woBody', 'click', '[data-wo-reopen]', async (e, el) => {
      const wo = (App.workOrders || []).filter(w => w.id === el.dataset.woReopen)[0];
      if (!wo) return;
      const ok = await Modal.confirm({
        title: '反结单',
        html: '将把工单 <b>' + Util.esc(wo.no) + '</b> 恢复为「生产中」。<br><br>' +
              '注意：结单时已复位并归档的盘位数据<b>不会被恢复</b>，' +
              '该工单的工序进度将按剩余记录重新计算。',
        okText: '反结单', danger: true
      });
      if (!ok) return;
      WorkOrder.reopen(wo);
      await save(App.workOrders);
      render();
      Toast.ok('已反结单');
    });

    Dom.delegate('woBody', 'click', '[data-wo-del]', async (e, el) => {
      const wo = (App.workOrders || []).filter(w => w.id === el.dataset.woDel)[0];
      if (!wo) return;
      if (wo.status === 'closed') { Toast.warn('已结单的工单不可删除'); return; }
      const ok = await Modal.confirm({
        title: '删除工单', text: '确定删除「' + wo.no + '」？该操作不可撤销。',
        okText: '删除', danger: true
      });
      if (!ok) return;
      App.state.workOrders = App.workOrders.filter(w => w.id !== wo.id);
      await Repo.remove('workorders', wo.id);
      render();
      Toast.ok('已删除');
    });

    Dom.delegate('woBody', 'click', '#btnWoNew', openNew);

    Dom.delegate('woBody', 'click', '#btnWoExport', () => {
      const list = App.workOrders || [];
      if (!list.length) { Toast.warn('暂无工单'); return; }
      const rows = list.map(wo => [
        wo.no, wo.orderNo, wo.pn, wo.model, wo.qty, L.woState(wo.status),
        WorkOrder.processWithOrt(wo.model || wo.pn).join(' > '),
        wo.acceptedBy, wo.acceptedAt ? Util.fmtFull(wo.acceptedAt) : '',
        wo.closedBy, wo.closedAt ? Util.fmtFull(wo.closedAt) : '',
        wo.closeNote, Util.fmtFull(wo.createdAt)
      ]);
      Util.download('工单导出_' + Util.todayKey() + '.csv', Util.toCsv(
        ['工单号', '订单号', '料号', '机型', '生产数量', '状态', '工序链',
         '接单人', '接单时间', '结单确认人', '结单时间', '结单备注', '创建时间'], rows));
      Toast.ok('已导出 ' + rows.length + ' 条');
    });
  }

  return { render, bind };
})();
