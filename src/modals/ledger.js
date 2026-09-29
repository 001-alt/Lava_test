/* ============================================================================
   设备台账 —— 导入 xlsx + IP 映射维护
   ----------------------------------------------------------------------------
   两个页签：
     导入   选/拖 xlsx → 解析 → 预览差异 → 应用
     台账   设备清单（位置 / IP / 型号），带校验与编辑，可导出

   导入之后「拓扑来源」从合成切到台账：设备编号变成真实机柜号+位号，
   现场标号与看板一致，桥接阶段才能把巡检到的 IP 对应到设备。
   ============================================================================ */

const ModalLedger = (() => {

  let _tab = 'import';
  let _parsed = null;        // Ledger.parse 结果
  let _registry = null;      // Registry.fromLedger 结果
  let _fileName = '';
  let _busy = false;
  let _page = 1;
  let _filter = { station: '', keyword: '', onlyIssue: false };

  const OPTS = {
    includeBorrowed: true,
    skipFaulty: true,
    applyCounts: true
  };

  function open(tab) {
    _tab = tab || 'import';
    render();
  }

  /* ==========================================================================
     外壳
     ========================================================================== */
  function render() {
    const t = _tab;
    Modal.open({
      id: 'ledger',
      title: '设备台账',
      sub: '导入 Excel 台账 · 维护设备 IP 映射',
      size: 'full',
      body:
        '<div class="tabs-inline">' +
          '<button class="btn ' + (t === 'import' ? 'on' : '') + '" data-led-tab="import">导入台账</button>' +
          '<button class="btn ' + (t === 'list' ? 'on' : '') + '" data-led-tab="list">' +
            '设备清单' + (App.devices.length ? '（' + Util.num(App.devices.length) + '）' : '') + '</button>' +
          '<span class="spacer" style="flex:1"></span>' +
          statusChip() +
        '</div>' +
        '<div id="ledBody"></div>',
      footer: '<button class="btn" data-mclose="1">关闭</button>',
      onMount(h) {
        h.el.addEventListener('click', e => {
          const tb = e.target.closest('[data-led-tab]');
          if (tb) { _tab = tb.dataset.ledTab; render(); }
        });
        renderBody();
      }
    });
  }

  function statusChip() {
    if (Repo.isDegraded()) return '<span class="chip warn">存储降级模式</span>';
    return '<span class="chip ' + (App.devices.length ? 'ok' : '') + '">' +
      (App.devices.length ? '台账已导入' : '未导入台账') + '</span>';
  }

  function renderBody() {
    const box = document.getElementById('ledBody');
    if (!box) return;
    box.innerHTML = _tab === 'import' ? importHtml() : listHtml();
    if (_tab === 'list') bindList();
  }

  /* ==========================================================================
     页签一：导入
     ========================================================================== */
  function importHtml() {
    if (_busy) {
      return '<div class="loading"><span class="spinner"></span>正在解析台账…</div>';
    }
    if (!_parsed) {
      return '' +
        '<div class="drop-zone" id="ledDrop">' +
          '<div class="dz-icon">📄</div>' +
          '<div class="dz-title">把设备台账拖到这里，或点击选择文件</div>' +
          '<div class="dz-sub">支持 .xlsx（Excel 工作簿）。解析在本地完成，文件不会上传到任何地方。</div>' +
          '<input type="file" id="ledFile" accept=".xlsx" style="display:none">' +
        '</div>' +
        '<div class="note">' +
          '<b>台账里需要有什么</b>：一张含「机柜号 / 设备型号 / 服务器位置 / 工位 / IP」等列的明细表。' +
          '解析器按表头名定位列，列顺序随意；一张工作表里有多张子表（如服务器表 + 箱体表）也能识别。<br>' +
          '导入后设备编号会变成<b>真实机柜号 + 位号</b>（如 S35#-3），与现场标号一致。' +
        '</div>' +
        (App.devices.length
          ? '<div class="note warn">当前已有 ' + Util.num(App.devices.length) +
            ' 台设备台账。再次导入会<b>整体替换</b>。</div>'
          : '');
    }
    return previewHtml();
  }

  function previewHtml() {
    const p = _parsed, r = _registry;
    const d = Registry.diffCounts(r.devices, App.cfg);
    const s = r.stats;

    const diffRows = d.map(x => ({
      name: x.name, cn: x.cn, color: x.color,
      configured: x.configured, ledger: x.ledger, diff: x.diff,
      online: x.online
    }));

    const diffCols = [
      { key: 'name', label: '工序' },
      { key: 'cn', label: '中文' },
      { key: 'configured', label: '看板配置', cls: 'num' },
      { key: 'ledger', label: '台账台数', cls: 'num' },
      { key: 'diff', label: '差异', cls: 'num', html: v =>
          v === 0 ? '<span class="muted">一致</span>'
            : '<b style="color:' + (v > 0 ? 'var(--ok)' : 'var(--bad)') + '">' +
              (v > 0 ? '+' : '') + v + '</b>' },
      { key: 'online', label: '同时在线', cls: 'num', fmt: v => Util.num(v) }
    ];

    return '' +
      '<div class="note ok">已解析 <b>' + Util.esc(_fileName) + '</b>：' +
        '识别到 <b>' + p.tables.length + '</b> 张子表，' +
        '<b>' + Util.num(s.total) + '</b> 台设备、' +
        '<b>' + Util.num(s.ipCount) + '</b> 个 IP、' +
        '<b>' + s.cabinetCount + '</b> 个机柜' +
        (s.zoneCount ? '、' + s.zoneCount + ' 个区域' : '') + '。' +
      '</div>' +

      (r.warnings.length || p.warnings.length
        ? '<div class="section-title">解析提示</div>' +
          r.warnings.concat(p.warnings).map(w =>
            '<div class="note warn" style="margin:6px 0">' + Util.esc(w) + '</div>').join('')
        : '') +

      '<div class="section-title">工站台数对比' +
        '<span class="note-inline">台账实测 vs 看板当前配置</span></div>' +
      DataTable.build(diffCols, diffRows) +

      '<div class="section-title">导入选项</div>' +
      '<div class="settings-card">' +
        opt('includeBorrowed', '纳入借用设备',
            '台账里标记为「WTS借用设备」的条目。现场确认这些是调拨给本产线在用的。', s.borrowed) +
        opt('skipFaulty', '排除故障/维修区域',
            '位于「故障机台」「维修」等区域的设备，不参与生产统计。') +
        opt('applyCounts', '按台账更新工站设备数',
            '把各工站的设备数改为台账实测值（影响产能与瓶颈计算）。' +
            '不勾选则只导入设备清单与 IP，不改动工站配置。') +
      '</div>' +

      '<div class="section-title">设备抽样（前 12 台）</div>' +
      DataTable.build([
        { key: 'station', label: '工序' },
        { key: 'cabinet', label: '机柜' },
        { key: 'pos', label: '位号' },
        { key: 'box', label: '箱号' },
        { key: 'id', label: '设备编号', cls: 'col-sn' },
        { key: 'ip', label: 'IP', cls: 'col-sn' },
        { key: 'model', label: '型号' },
        { key: 'borrowed', label: '归属', html: v =>
            v ? '<span class="pill p-warn">借用</span>' : '<span class="pill p-wait">自有</span>' }
      ], r.devices.slice(0, 12)) +

      '<div class="toolbar" style="margin-top:14px">' +
        '<button class="btn primary" id="ledApply">应用导入</button>' +
        '<button class="btn" id="ledCancel">重新选择文件</button>' +
      '</div>';
  }

  function opt(key, label, desc, count) {
    return '<label class="opt-row">' +
      '<input type="checkbox" data-led-opt="' + key + '"' + (OPTS[key] ? ' checked' : '') + '>' +
      '<span class="opt-text"><b>' + Util.esc(label) + '</b>' +
        (count ? ' <span class="pill p-warn">' + count + ' 台</span>' : '') +
        '<span class="opt-desc">' + Util.esc(desc) + '</span></span>' +
    '</label>';
  }

  /* ==========================================================================
     页签二：设备清单（IP 映射）
     ========================================================================== */
  function listHtml() {
    const all = App.devices;
    if (!all.length) {
      return '<div class="empty-tip">尚未导入设备台账。切到「导入台账」页签选择 xlsx 文件。</div>';
    }
    const issues = Registry.validate(all);

    /* 过滤 */
    let list = all.slice();
    if (_filter.station) list = list.filter(d => d.station === _filter.station);
    if (_filter.keyword) {
      const kw = _filter.keyword.toUpperCase();
      list = list.filter(d =>
        String(d.id).toUpperCase().indexOf(kw) >= 0 ||
        String(d.ip).indexOf(kw) >= 0 ||
        String(d.cabinet).toUpperCase().indexOf(kw) >= 0 ||
        String(d.model).toUpperCase().indexOf(kw) >= 0);
    }
    if (_filter.onlyIssue) {
      list = list.filter(d => !d.ip || issues.dupIp[d.ip] || issues.invalidIp[d.id]);
    }

    const byStation = {};
    all.forEach(d => { byStation[d.station || '(未识别)'] = (byStation[d.station || '(未识别)'] || 0) + 1; });

    const cols = [
      { key: 'station', label: '工序' },
      { key: 'cabinet', label: '机柜', fmt: v => v || '--' },
      { key: 'zone', label: '区域', fmt: v => v || '--' },
      { key: 'pos', label: '位号', fmt: v => v || '--' },
      { key: 'box', label: '箱号', fmt: v => v || '--' },
      { key: 'id', label: '设备编号', cls: 'col-sn' },
      { key: 'ip', label: 'IP', cls: 'col-sn', html: (v, row) => {
          if (!v) return '<span style="color:var(--bad)">未填</span>';
          if (!Util.isIp(v)) return '<span style="color:var(--bad)">格式错：' + Util.esc(v) + '</span>';
          if (issues.dupIp[v]) return '<span style="color:var(--warn)" title="与 ' +
            Util.esc(issues.dupIp[v].filter(x => x !== row.id).join('、')) + ' 重复">' +
            Util.esc(v) + ' ⚠</span>';
          return Util.esc(v);
        } },
      { key: 'model', label: '型号', fmt: v => v || '--' },
      { key: 'borrowed', label: '归属', html: v =>
          v ? '<span class="pill p-warn">借用</span>' : '<span class="pill p-wait">自有</span>' },
      { key: 'act', label: '操作', html: (v, row) =>
          '<button class="btn xs" data-led-edit="' + Util.esc(row.id) + '">改IP</button>' }
    ];

    const pg = DataTable.paginated(cols, list, _page, 200);

    const dupCount = Object.keys(issues.dupIp).length;
    const invalidCount = Object.keys(issues.invalidIp).length;
    const noIpCount = issues.noIp.length;

    return '' +
      '<div class="cards">' +
        '<div class="card"><div class="lbl">设备总数</div>' +
          '<div class="val">' + Util.num(all.length) + '</div>' +
          '<div class="sub">' + Object.keys(byStation).length + ' 个工站</div></div>' +
        '<div class="card"><div class="lbl">已配 IP</div>' +
          '<div class="val" style="color:var(--ok)">' + Util.num(all.length - noIpCount) + '</div>' +
          '<div class="sub">可接入桥接</div></div>' +
        '<div class="card"><div class="lbl">缺 IP</div>' +
          '<div class="val" style="color:' + (noIpCount ? 'var(--bad)' : 'var(--tx-3)') + '">' +
            Util.num(noIpCount) + '</div></div>' +
        '<div class="card"><div class="lbl">IP 重复 / 格式错</div>' +
          '<div class="val" style="color:' + ((dupCount || invalidCount) ? 'var(--warn)' : 'var(--tx-3)') + '">' +
            dupCount + ' / ' + invalidCount + '</div></div>' +
        '<div class="card"><div class="lbl">借用设备</div>' +
          '<div class="val">' + Util.num(all.filter(d => d.borrowed).length) + '</div></div>' +
      '</div>' +

      (dupCount || invalidCount || noIpCount
        ? '<div class="note warn">存在 ' + (dupCount + invalidCount + noIpCount) +
          ' 处问题，点「只看异常」筛选后逐条修正。IP 重复会导致桥接把数据归到错误的设备上。</div>'
        : '<div class="note ok">IP 映射无异常，可作为桥接服务的连接清单。</div>') +

      '<div class="toolbar">' +
        '<select class="form-select" id="ledFStation" style="width:150px">' +
          '<option value="">全部工序</option>' +
          Object.keys(byStation).sort().map(k =>
            '<option value="' + Util.esc(k) + '"' + (_filter.station === k ? ' selected' : '') + '>' +
            Util.esc(k) + '（' + byStation[k] + '）</option>').join('') +
        '</select>' +
        '<input class="form-input" id="ledFKw" style="width:200px" placeholder="搜编号 / IP / 机柜 / 型号" value="' +
          Util.esc(_filter.keyword) + '">' +
        '<label class="legend-chk"><input type="checkbox" id="ledFIssue"' +
          (_filter.onlyIssue ? ' checked' : '') + '> 只看异常</label>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn" id="ledExportCsv">导出 CSV</button>' +
        '<button class="btn" id="ledExportBridge">导出桥接清单</button>' +
        '<button class="btn danger" id="ledClear">清空台账</button>' +
      '</div>' +

      pg.html;
  }

  function bindList() {
    const body = document.getElementById('ledBody');
    if (!body) return;

    const st = body.querySelector('#ledFStation');
    if (st) st.onchange = () => { _filter.station = st.value; _page = 1; renderBody(); };
    const kw = body.querySelector('#ledFKw');
    if (kw) kw.oninput = Util.debounce(() => {
      _filter.keyword = kw.value.trim(); _page = 1; renderBody();
    }, 300);
    const is = body.querySelector('#ledFIssue');
    if (is) is.onchange = () => { _filter.onlyIssue = is.checked; _page = 1; renderBody(); };

    body.addEventListener('click', async e => {
      if (e.target.closest('#ledExportCsv')) {
        Util.download('设备台账_' + Util.tsTag() + '.csv', Registry.toCsv(App.devices));
        Toast.ok('已导出 ' + App.devices.length + ' 台设备');
        return;
      }
      if (e.target.closest('#ledExportBridge')) {
        const list = Registry.toBridgeList(App.devices);
        Util.download('桥接连接清单_' + Util.tsTag() + '.json',
          JSON.stringify({
            说明: '供桥接服务用的机台连接清单：每项含 IP 与所属工站/设备',
            生成时间: Util.nowStr(),
            总数: list.length,
            机台: list
          }, null, 2), 'application/json;charset=utf-8');
        Toast.ok('已导出 ' + list.length + ' 个机台');
        return;
      }
      if (e.target.closest('#ledClear')) {
        const ok = await Modal.confirm({
          title: '清空设备台账',
          html: '将删除设备清单与 IP 映射，拓扑退回「按工站配置合成」模式。<br>' +
                '⚙️ 盘位测试数据与记录<b>不受影响</b>。',
          okText: '清空', danger: true
        });
        if (!ok) return;
        await App.saveDevices([]);
        Topology.setRegistry(null);
        render();
        App.switchView(App.state.curView);
        Toast.ok('已清空设备台账');
        return;
      }
      const ed = e.target.closest('[data-led-edit]');
      if (ed) { editIp(ed.dataset.ledEdit); return; }
      const pg = e.target.closest('[data-pg]');
      if (pg) {
        _page = DataTable.handlePage(pg.dataset.pg, _page, App.devices.length, 200);
        renderBody();
      }
    });
  }

  async function editIp(id) {
    const d = App.devices.filter(x => x.id === id)[0];
    if (!d) return;
    const v = await Modal.prompt({
      title: '修改设备 IP',
      text: d.id + '（' + d.station + (d.cabinet ? ' · ' + d.cabinet : '') + '）',
      value: d.ip,
      hint: '留空表示该设备暂不接入。格式须为 IPv4。'
    });
    if (v == null) return;
    const ip = String(v).trim();
    if (ip && !Util.isIp(ip)) { Toast.warn('IP 格式不正确'); return; }
    const dup = App.devices.filter(x => x.ip === ip && x.id !== id)[0];
    if (dup) {
      const go = await Modal.confirm({
        title: 'IP 重复', html: 'IP <b>' + Util.esc(ip) + '</b> 已被 <b>' + Util.esc(dup.id) +
          '</b> 占用。仍然保存吗？', okText: '仍然保存', danger: true
      });
      if (!go) return;
    }
    d.ip = ip;
    await App.saveDevices(App.devices);
    renderBody();
    Toast.ok('已更新');
  }

  /* ==========================================================================
     文件选择与解析
     ========================================================================== */
  function pickFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx';
    input.onchange = () => { if (input.files[0]) handleFile(input.files[0]); };
    input.click();
  }

  async function handleFile(file) {
    if (!/\.xlsx$/i.test(file.name)) {
      Toast.error('只支持 .xlsx 格式（老式 .xls 请另存为 .xlsx）');
      return;
    }
    _busy = true; _fileName = file.name; renderBody();
    try {
      const buf = await file.arrayBuffer();
      const wb = await Xlsx.parse(buf);
      if (!wb.sheets.length) throw new Error('工作簿里没有工作表');
      // 取第一张有内容的表；本项目台账都是单表
      const sheet = wb.sheets.reduce((a, b) =>
        (b.rows && b.rows.length > (a.rows ? a.rows.length : 0)) ? b : a, wb.sheets[0]);
      _parsed = Ledger.parse(sheet);
      _registry = Registry.fromLedger(_parsed, { skipFaulty: OPTS.skipFaulty });
      _busy = false;
      renderBody();
    } catch (e) {
      _busy = false; _parsed = null; _registry = null;
      console.error('[Ledger] 解析失败：', e);
      Toast.error('解析失败：' + e.message, file.name);
      renderBody();
    }
  }

  /* ==========================================================================
     应用导入
     ========================================================================== */
  async function apply() {
    if (!_registry) return;
    const go = await Modal.confirm({
      title: '应用设备台账',
      html: '将写入 <b>' + Util.num(_registry.devices.length) + '</b> 台设备' +
            (OPTS.applyCounts ? '，并把各工站设备数改为台账实测值' : '（不改动工站配置）') +
            '。<br><br>⚠️ 设备编号会变为真实机柜号+位号（如 S35#-3）。' +
            '已存在的盘位测试数据按<b>旧编号</b>存储，切换后不会自动迁移，' +
            '建议先到「导出中心」备份。',
      okText: '确认应用'
    });
    if (!go) return;

    try {
      /* 1. 工站设备数 */
      if (OPTS.applyCounts) {
        const counts = Registry.countsFromLedger(_registry.devices);
        const ov = {};
        Object.keys(counts).forEach(k => {
          const base = ST[k];
          if (!base) return;
          if (counts[k] !== base.count) ov[k] = { count: counts[k] };
        });
        App.cfg.stationOverride = ov;
        LocalStore.save();
        Topology.invalidate();
      }

      /* 2. 设备清单落库 */
      await App.saveDevices(_registry.devices);

      /* 3. 切换拓扑到台账模式 */
      Topology.setRegistry(App.devices);
      Topology.invalidate();

      /* 4. 盘位表清理：旧编号的盘位在新拓扑下已无意义 */
      const valid = new Set();
      Topology.all(App.cfg).equipment.forEach(eq => {
        eq.slotKeys.forEach(k => valid.add(k));
      });
      const stale = (await Repo.getAllSlots()).filter(s => !valid.has(s.key));
      if (stale.length) {
        await Repo.removeWhere('slots', s => !valid.has(s.key));
        console.warn('[Ledger] 清理了 ' + stale.length + ' 条旧编号盘位');
      }

      await App.loadAll();
      Modal.closeById('ledger');
      App.switchView(App.state.curView);
      App.refreshStatus();

      Toast.ok('设备 ' + Util.num(App.devices.length) + ' 台已导入' +
        (stale.length ? '，清理旧编号盘位 ' + Util.num(stale.length) + ' 条' : '') +
        '。拓扑已切换为「真实台账」模式。', '导入完成');
    } catch (e) {
      console.error('[Ledger] 应用失败：', e);
      Toast.error('应用失败：' + e.message);
    }
  }

  /* ==========================================================================
     事件绑定（模态内委托）
     ========================================================================== */
  document.addEventListener('click', e => {
    const drop = e.target.closest('#ledDrop');
    if (drop) { pickFile(); return; }
    const f = e.target.closest('#ledFile');
    if (f) return;
    if (e.target.closest('#ledApply')) { apply(); return; }
    if (e.target.closest('#ledCancel')) {
      _parsed = null; _registry = null; renderBody(); return;
    }
  });

  document.addEventListener('change', e => {
    const o = e.target.closest('[data-led-opt]');
    if (!o) return;
    OPTS[o.dataset.ledOpt] = o.checked;
    // 借用/故障开关会改变台账构成，需重新生成预览
    if (_parsed && (o.dataset.ledOpt === 'skipFaulty' || o.dataset.ledOpt === 'includeBorrowed')) {
      _registry = Registry.fromLedger(_parsed, { skipFaulty: OPTS.skipFaulty });
      renderBody();
    }
  });

  /* 拖放 */
  document.addEventListener('dragover', e => {
    const dz = e.target.closest && e.target.closest('#ledDrop');
    if (dz) { e.preventDefault(); dz.classList.add('over'); }
  });
  document.addEventListener('dragleave', e => {
    const dz = e.target.closest && e.target.closest('#ledDrop');
    if (dz) dz.classList.remove('over');
  });
  document.addEventListener('drop', e => {
    const dz = e.target.closest && e.target.closest('#ledDrop');
    if (!dz) return;
    e.preventDefault();
    dz.classList.remove('over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  return { open };
})();
