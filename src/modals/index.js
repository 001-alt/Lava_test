/* ============================================================================
   模态框集合
   ----------------------------------------------------------------------------
   阶段 1 先交付三个关键模态框：
     ModalDefectRules   不良判定规则 + 试判定（判定引擎的配置入口）
     ModalExportCenter  导出中心
     ModalSettings      系统设置（工站配置 / 通道 / 节拍）
   其余（机柜台账、IP 映射、批量设置、字段管理等）在后续阶段补齐。
   ============================================================================ */

/* ==========================================================================
   不良判定设置
   ========================================================================== */
const ModalDefectRules = (() => {

  function open() {
    const cfg = App.cfg;
    DefectEngine.ensureRules(cfg);
    LocalStore.save();
    renderBody(cfg);
  }

  function renderBody(cfg) {
    const rules = DefectEngine.rules(cfg).slice()
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));
    const stats = DefectEngine.hitStats(cfg);

    const cols = [
      { key: 'priority', label: '优先级', cls: 'num', width: '66px' },
      { key: 'enabled', label: '启用', width: '54px', html: v =>
          '<input type="checkbox" data-rule-toggle="' + v.id + '"' + (v.enabled ? ' checked' : '') + '>' },
      { key: 'matchType', label: '匹配方式', fmt: (v, r) => L.matchType(r.matchType) },
      { key: 'pattern', label: '匹配内容', cls: 'col-sn' },
      { key: 'verdict', label: '判定', html: (v, r) =>
          '<span class="pill ' + (r.verdict === 'functional' ? 'p-fail'
            : r.verdict === 'nonfunctional' ? 'p-wait' : 'p-warn') + '">' +
          Util.esc(L.verdict(r.verdict)) + '</span>' },
      { key: 'defectType', label: '不良类型' },
      { key: 'hitCount', label: '命中', cls: 'num', fmt: v => Util.num(v || 0) },
      { key: 'updatedAt', label: '更新时间', fmt: v => Util.esc(v || '--') },
      { key: 'act', label: '操作', html: (v, r) =>
          '<button class="btn xs" data-rule-edit="' + r.id + '">编辑</button>' +
          '<button class="btn xs danger" data-rule-del="' + r.id + '" style="margin-left:4px">删</button>' }
    ];

    const body =
      '<div class="note">' +
        '判定规则按<b>优先级升序</b>匹配，<b>首个命中即返回</b>。<br>' +
        '三种判定结论：<b>功能性不良</b>写入不良记录并自动确认；' +
        '<b>非功能性</b>只留流水不入不良（如机柜侧事件）；' +
        '<b>待确认</b>写入不良但等人工确认。<br>' +
        '⚠️ 规则变更<b>只影响后续判定，不重算历史记录</b> —— 这是有意设计，保证判定流水可审计。' +
      '</div>' +

      '<div class="toolbar">' +
        '<button class="btn primary" id="ruleAdd">新增规则</button>' +
        '<button class="btn warn" id="ruleReset">恢复默认规则</button>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<span class="hint" style="margin:0">共 ' + rules.length + ' 条，启用 ' +
          rules.filter(r => r.enabled).length + ' 条</span>' +
      '</div>' +

      DataTable.build(cols, rules) +

      '<div class="section-title">试判定' +
        '<span class="note-inline">用样本文本验证规则，不会记入统计</span></div>' +
      '<div class="form-row-3">' +
        '<div class="form-group"><label class="form-label">样本文本</label>' +
          '<input class="form-input" id="testText" placeholder="粘贴一段日志或报错文本"></div>' +
        '<div class="form-group"><label class="form-label">错误码（可选）</label>' +
          '<input class="form-input" id="testCode" placeholder="如 E-BIST-407"></div>' +
        '<div class="form-group"><label class="form-label">工站（可选）</label>' +
          '<select class="form-select" id="testStation">' +
            '<option value="">—</option>' +
            Topology.effectiveStations(cfg).map(s =>
              '<option value="' + s.key + '">' + s.name + '</option>').join('') +
          '</select></div>' +
      '</div>' +
      '<div style="margin-top:9px"><button class="btn" id="testRun">试判定</button></div>' +
      '<div id="testResult"></div>' +

      '<div class="section-title">命中统计</div>' +
      (stats.length
        ? DataTable.build([
            { key: 'pattern', label: '匹配内容', cls: 'col-sn' },
            { key: 'matchType', label: '方式', fmt: v => L.matchType(v) },
            { key: 'verdict', label: '判定', fmt: v => L.verdict(v) },
            { key: 'hits', label: '命中次数', cls: 'num' },
            { key: 'enabled', label: '状态', html: v =>
              v ? '<span class="pill p-pass">启用</span>' : '<span class="pill p-wait">停用</span>' }
          ], stats)
        : '<div class="empty-tip">尚无命中记录</div>');

    Modal.open({
      id: 'defectRules',
      title: '不良判定设置',
      sub: '规则表 · 试判定 · 命中统计',
      size: 'wider',
      body,
      footer: '<button class="btn" data-mclose="1">关闭</button>',
      onMount(h) { bindEvents(h); }
    });
  }

  function bindEvents(h) {
    const cfg = App.cfg;

    h.el.addEventListener('click', async e => {
      /* 新增 / 编辑 */
      const addBtn = e.target.closest('#ruleAdd');
      const editBtn = e.target.closest('[data-rule-edit]');
      if (addBtn || editBtn) {
        const id = editBtn ? editBtn.dataset.ruleEdit : null;
        const cur = id ? DefectEngine.rules(cfg).filter(r => r.id === id)[0] : null;
        openRuleEditor(h, cur);
        return;
      }

      /* 删除 */
      const delBtn = e.target.closest('[data-rule-del]');
      if (delBtn) {
        const ok = await Modal.confirm({
          title: '删除规则', text: '删除后该规则不再参与判定，历史流水不受影响。',
          okText: '删除', danger: true
        });
        if (!ok) return;
        DefectEngine.removeRule(cfg, delBtn.dataset.ruleDel);
        LocalStore.save();
        h.close(); open();
        Toast.ok('已删除规则');
        return;
      }

      /* 恢复默认 */
      if (e.target.closest('#ruleReset')) {
        const ok = await Modal.confirm({
          title: '恢复默认规则',
          html: '将清空当前规则表并重建为内置默认规则。<br>' +
                '⚠️ 已命中的统计数据会归零，但<b>不良记录与判定流水不受影响</b>。',
          okText: '恢复', danger: true
        });
        if (!ok) return;
        DefectEngine.resetRules(cfg);
        LocalStore.save();
        h.close(); open();
        Toast.ok('已恢复默认规则');
        return;
      }

      /* 试判定 */
      if (e.target.closest('#testRun')) {
        const text = h.query('#testText').value.trim();
        const code = h.query('#testCode').value.trim() || ErrCodeRules.extract(text);
        const station = h.query('#testStation').value;
        const r = DefectEngine.dryRun(cfg, text, code, station);
        const v = VERDICT[r.verdict] || VERDICT.unknown;
        h.query('#testResult').innerHTML =
          '<div class="note ' + (r.ruleId ? 'ok' : 'warn') + '">' +
            '结论：<b>' + Util.esc(L.verdict(r.verdict)) + '</b>' +
            ' · 不良类型：<b>' + Util.esc(r.defectType) + '</b>' +
            (code ? '<br>错误码：<b>' + Util.esc(code) + '</b>' : '') +
            '<br>' + (r.ruleId
              ? '命中规则 <b>' + Util.esc(r.rule.pattern || '(any)') + '</b>' +
                '（优先级 ' + r.rule.priority + '，' +
                L.matchType(r.rule.matchType) + '）'
              : '未命中任何规则 → 进入<b>待确认</b>队列') +
            '<br>处置：' + (v.toBad ? '写入不良记录' : '不写入不良记录') +
            ' · 自动确认：' + (v.autoConfirm ? '是' : '否，需人工确认') +
          '</div>' +
          (!r.ruleId
            ? '<div style="margin-top:8px"><button class="btn sm" id="ruleFromTest">' +
              '按此内容新建规则</button></div>' : '');
        return;
      }

      /* 从未命中样本一键建规则 */
      if (e.target.closest('#ruleFromTest')) {
        const text = h.query('#testText').value.trim().slice(0, 40);
        const code = h.query('#testCode').value.trim();
        openRuleEditor(h, null, { matchType: code ? 'errcode' : 'keyword', pattern: code || text });
        return;
      }
    });

    /* 启用/停用 */
    h.el.addEventListener('change', e => {
      const t = e.target.closest('[data-rule-toggle]');
      if (!t) return;
      DefectEngine.toggleRule(cfg, t.dataset.ruleToggle, t.checked);
      LocalStore.save();
      Toast.ok(t.checked ? '规则已启用' : '规则已停用');
    });
  }

  function openRuleEditor(parentHandle, cur, preset) {
    const cfg = App.cfg;
    const r = cur || Object.assign({
      priority: (DefectEngine.rules(cfg).length + 1) * 10,
      enabled: true, matchType: 'keyword', pattern: '', verdict: 'unknown', defectType: ''
    }, preset || {});

    Modal.open({
      title: cur ? '编辑规则' : '新增规则',
      size: 'normal',
      body:
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label">优先级</label>' +
            '<input type="number" class="form-input" id="rPri" value="' + r.priority + '">' +
            '<div class="form-hint">数字小的先匹配</div></div>' +
          '<div class="form-group"><label class="form-label">启用</label>' +
            '<label class="radio-row" style="margin-top:6px">' +
            '<input type="checkbox" id="rEn" ' + (r.enabled !== false ? 'checked' : '') + '> 参与判定</label></div>' +
        '</div>' +
        '<div class="form-row" style="margin-top:11px">' +
          '<div class="form-group"><label class="form-label">匹配方式</label>' +
            '<select class="form-select" id="rType">' +
              Object.keys(MATCH_TYPE).map(k =>
                '<option value="' + k + '"' + (r.matchType === k ? ' selected' : '') + '>' +
                MATCH_TYPE[k] + '</option>').join('') +
            '</select></div>' +
          '<div class="form-group"><label class="form-label">匹配内容</label>' +
            '<input class="form-input" id="rPat" value="' + Util.esc(r.pattern || '') + '">' +
            '<div class="form-hint">关键词方式下，写成 <code>/正则/</code> 则按正则匹配</div></div>' +
        '</div>' +
        '<div class="form-row" style="margin-top:11px">' +
          '<div class="form-group"><label class="form-label">判定结论</label>' +
            '<select class="form-select" id="rVerdict">' +
              Object.keys(VERDICT).map(k =>
                '<option value="' + k + '"' + (r.verdict === k ? ' selected' : '') + '>' +
                VERDICT[k].label + '</option>').join('') +
            '</select></div>' +
          '<div class="form-group"><label class="form-label">不良类型</label>' +
            '<input class="form-input" id="rDefect" value="' + Util.esc(r.defectType || '') + '" ' +
              'placeholder="如 老化早期失效"></div>' +
        '</div>' +
        '<div class="note" style="margin-top:12px" id="rHint"></div>',
      footer: '<button class="btn" data-mclose="1">取消</button>' +
              '<button class="btn primary" id="rSave">保存</button>',
      onMount(hh) {
        const upd = () => {
          const v = hh.query('#rVerdict').value;
          hh.query('#rHint').innerHTML = v === 'functional'
            ? '功能性不良：命中后写入不良记录并<b>自动确认</b>。'
            : v === 'nonfunctional'
              ? '非功能性：只写判定流水，<b>不写入不良记录</b>（适用于机柜侧事件等）。'
              : '待确认：写入不良记录但<b>需人工确认</b>，平面图对应盘位会显示黄框。';
        };
        hh.query('#rVerdict').addEventListener('change', upd);
        upd();

        hh.el.addEventListener('click', async e => {
          if (!e.target.closest('#rSave')) return;
          const patch = {
            priority: Number(hh.query('#rPri').value) || 100,
            enabled: hh.query('#rEn').checked,
            matchType: hh.query('#rType').value,
            pattern: hh.query('#rPat').value.trim(),
            verdict: hh.query('#rVerdict').value,
            defectType: hh.query('#rDefect').value.trim()
          };
          if (!patch.pattern && patch.matchType !== 'any') {
            Toast.warn('匹配内容不能为空（除非匹配方式为「全部」）');
            return;
          }
          if (cur) DefectEngine.updateRule(cfg, cur.id, patch);
          else DefectEngine.addRule(cfg, patch);
          LocalStore.save();
          hh.close();
          if (parentHandle) { parentHandle.close(); }
          open();
          Toast.ok(cur ? '规则已更新' : '规则已新增');
        });
      }
    });
  }

  return { open };
})();

/* ==========================================================================
   导出中心
   ========================================================================== */
/* ==========================================================================
   导出中心
   ----------------------------------------------------------------------------
   三类导出：
     备份（JSON）  唯一可靠的恢复手段，换电脑/清浏览器数据都靠它
     记录（CSV）   查看与汇报用，带 BOM，Excel 打开不乱码
     图表（PNG）   汇报用

   ⚠️ CSV 不能用来恢复数据 —— 它丢了类型、丢了关联、丢了判定流水。
      界面上必须把这句话讲清楚，否则有人会拿 CSV 当备份。
   ========================================================================== */
const ModalExportCenter = (() => {

  /* 导出项声明式定义：加一项只加一条，不改渲染逻辑 */
  const GROUPS = [
    {
      key: 'backup', name: '数据备份（JSON）', icon: '💾',
      desc: '唯一可靠的恢复手段。换电脑、清浏览器数据、误操作后都靠它还原。',
      items: [
        { key: 'config', label: '配置备份', kind: 'json',
          desc: '规则表、设置、UI 偏好。几十 KB，换电脑最快。' },
        { key: 'snapshot', label: '状态快照', kind: 'json',
          desc: '盘位现状 + 工单 + 待确认不良。约 1-2 MB。' },
        { key: 'full', label: '全量备份', kind: 'json', danger: true,
          desc: '另含全部测试记录 / 不良 / 报错 / 判定流水。体积随记录增长。' }
      ]
    },
    {
      key: 'records', name: '业务记录（CSV）', icon: '📋',
      desc: '按日期范围导出。带 UTF-8 BOM，Excel 打开不乱码。',
      scoped: true,
      items: [
        { key: 'records', label: '测试记录', count: () => (App.records || []).length },
        { key: 'bad', label: '不良记录', count: () => (App.bad || []).length },
        { key: 'error', label: '报错记录', count: () => (App.error || []).length },
        { key: 'judgements', label: '判定流水', count: () => App.state.judgements ? App.state.judgements.length : null,
          desc: '不可变审计流水，可回溯每次判定的原文与命中规则' },
        { key: 'pendingBad', label: '待确认不良', count: () => (App.bad || []).filter(b => !b.confirmed).length,
          desc: '仅未确认的，便于发给技术员逐条处理' }
      ]
    },
    {
      key: 'assets', name: '台账与清单（CSV）', icon: '🗂',
      desc: '设备与位置类数据，不随日期变化。',
      items: [
        { key: 'devices', label: '设备台账', count: () => App.devices.length,
          desc: '设备编号 / 位置 / IP / 型号 —— 桥接与排产的依据' },
        { key: 'slots', label: '盘位现状', count: () => App.slots.size },
        { key: 'wo', label: '工单', count: () => (App.workOrders || []).length },
        { key: 'errStats', label: '报错统计汇总',
          desc: '总数 / 按类型 / 按位置 / 按日期 的分段汇总，适合直接贴进周报' },
        { key: 'realtime', label: '设备实时状态',
          desc: '最近一次 SSH 巡检结果（在线 / 在测 / 数据新鲜度）' },
        { key: 'loglist', label: '日志文件清单', count: () => (App.logindex || []).length }
      ]
    },
    {
      key: 'charts', name: '图表（PNG）', icon: '📈',
      desc: '直接在汇报材料里用，无需重新截图。',
      items: [
        { key: 'chartCapacity', label: '各工序产能' },
        { key: 'chartOccupancy', label: '盘位占用' },
        { key: 'chartBadType', label: '不良类型分布' },
        { key: 'chartErrTop', label: '报错类型 TOP' }
      ]
    }
  ];

  let _scope = 'all';

  function open() {
    Modal.open({
      id: 'exportCenter',
      title: '导出中心',
      sub: '备份 · 记录 · 台账 · 图表',
      size: 'full',
      body:
        '<div class="note">' +
          '<b>JSON 与 CSV 不可互相替代</b>：JSON 是完整快照，能用来恢复；' +
          'CSV 只适合查看与汇报，<b>丢掉类型、关联与判定流水，不能用来恢复数据</b>。' +
        '</div>' +
        '<div class="tabs-inline">' +
          '<span class="hint" style="margin:0">导出范围（仅对记录类生效）：</span>' +
          ['all|全部', 'today|仅今日', '7d|近 7 天'].map(x => {
            const k = x.split('|')[0], n = x.split('|')[1];
            return '<button class="btn sm' + (_scope === k ? ' on' : '') +
              '" data-exp-scope="' + k + '">' + n + '</button>';
          }).join('') +
          '<span class="spacer" style="flex:1"></span>' +
          '<button class="btn sm" id="expImport">导入备份…</button>' +
        '</div>' +
        '<div id="expGroups"></div>' +
        '<div class="section-title">危险操作</div>' +
        '<div class="toolbar">' +
          '<button class="btn danger" id="expClear">清空全部数据</button>' +
          '<span class="hint" style="margin:0">清空前请务必先导出备份。</span>' +
        '</div>',
      footer: '<button class="btn" data-mclose="1">关闭</button>',
      onMount(h) { renderGroups(h); bind(h); }
    });
  }

  function renderGroups(h) {
    const box = (h && h.query('#expGroups')) || document.getElementById('expGroups');
    if (!box) return;
    box.innerHTML = GROUPS.map(g =>
      '<div class="section-title">' + g.icon + ' ' + Util.esc(g.name) +
        '<span class="note-inline">' + Util.esc(g.desc) + '</span></div>' +
      '<div class="exp-grid">' + g.items.map(it => {
        const n = typeof it.count === 'function' ? it.count() : null;
        return '<button class="exp-btn' + (it.danger ? ' danger' : '') +
          '" data-exp="' + it.key + '" title="' + Util.escAttr(it.desc || '') + '">' +
          '<span class="exp-lbl">' + Util.esc(it.label) + '</span>' +
          (n != null ? '<span class="exp-cnt">' + Util.num(n) + '</span>' : '') +
          (it.desc ? '<span class="exp-desc">' + Util.esc(Util.truncate(it.desc, 42)) + '</span>' : '') +
        '</button>';
      }).join('') + '</div>').join('');
  }

  /* 日期范围过滤 */
  function inScope(list) {
    if (_scope === 'all') return list;
    if (_scope === 'today') {
      const t = Util.todayKey();
      return list.filter(x => (x.day || (x.time ? Util.todayKey(new Date(x.time)) : '')) === t);
    }
    const from = Util.todayKey(new Date(Date.now() - 6 * 86400000));
    return list.filter(x => {
      const d = x.day || (x.time ? Util.todayKey(new Date(x.time)) : '');
      return d && d >= from;
    });
  }

  const scopeName = () => ({ all: '全部', today: '今日', '7d': '近7天' }[_scope] || _scope);

  /* --------------------------------------------------------------------------
     CSV 定义：headers + rows
     -------------------------------------------------------------------------- */
  function buildCsv(key) {
    const cfg = App.cfg;
    switch (key) {
      case 'records': {
        const list = inScope((App.records || []).slice());
        return { name: '测试记录', headers: ['日期', '时间', '工站', '机柜', '设备', '位号', 'SN', 'PN', '型号', '工单', '结果', '错误码', '来源'],
          rows: list.map(r => [r.day, r.time ? Util.fmtFull(r.time) : '', r.station, r.cabinetId,
            r.equipmentId, r.slotIndex == null ? '' : (r.slotIndex + 1), r.sn, r.pn, r.model,
            r.woNo, L.result(r.result), r.errCode, L.source(r.source)]) };
      }
      case 'bad': {
        const list = inScope((App.bad || []).slice());
        return { name: '不良记录', headers: ['日期', '时间', '工站', '机柜', '设备', '位号', 'SN', 'PN', '型号', '工单', '不良类型', '错误码', '判定', '状态', '确认人', '确认时间', '来源', '备注'],
          rows: list.map(b => [b.day, b.time ? Util.fmtFull(b.time) : '', b.station, b.cabinetId,
            b.serverId, b.slotIndex == null ? '' : (b.slotIndex + 1), b.sn, b.pn, b.model, b.woNo,
            b.type, b.errCode, L.verdict(b.verdict), b.confirmed ? '已确认' : '待确认',
            b.confirmedBy, b.confirmedAt ? Util.fmtFull(b.confirmedAt) : '',
            L.source(b.source), b.note]) };
      }
      case 'error': {
        const list = inScope((App.error || []).slice());
        return { name: '报错记录', headers: ['日期', '首次时间', '最近时间', '工站', '机柜', '设备', '类型', '信息', '错误码', '次数', '状态', '来源'],
          rows: list.map(e => [e.day, e.firstTime ? Util.fmtFull(e.firstTime) : '',
            e.lastTime ? Util.fmtFull(e.lastTime) : '', e.station, e.cabinetId, e.equipmentId,
            e.type, e.message, e.errCode, e.count, e.handled ? '已处理' : '待处理', L.source(e.source)]) };
      }
      case 'judgements': {
        const list = inScope((App.state.judgements || []).slice());
        return { name: '判定流水', headers: ['时间', '来源', '原文', '错误码', '工站', '位号', 'SN', '判定', '规则', '置信度', '已确认', '确认人', '确认时间'],
          rows: list.map(j => [j.at ? Util.fmtFull(j.at) : '', L.source(j.source), j.rawText,
            j.errCode, j.station, j.slotIndex, j.sn, L.verdict(j.verdict), j.ruleId || '(未命中)',
            j.confidence, j.confirmed ? '是' : '否', j.confirmedBy,
            j.confirmedAt ? Util.fmtFull(j.confirmedAt) : '']) };
      }
      case 'pendingBad': {
        const list = (App.bad || []).filter(b => !b.confirmed);
        return { name: '待确认不良', headers: ['日期', '工站', '机柜', '设备', '位号', 'SN', 'PN', '不良类型', '错误码', '备注', '判定流水ID'],
          rows: list.map(b => [b.day, b.station, b.cabinetId, b.serverId,
            b.slotIndex == null ? '' : (b.slotIndex + 1), b.sn, b.pn, b.type, b.errCode,
            b.note, b.judgementId]) };
      }
      case 'devices': {
        return { name: '设备台账', headers: ['工站', '机柜', '区域', '位号', '箱号', '设备编号', 'IP', '备用IP', '型号', '归属', '台账行号'],
          rows: App.devices.map(d => [d.station, d.cabinet, d.zone, d.pos, d.box, d.id,
            d.ip, d.ipAlt, d.model, d.borrowed ? '借用' : '自有', d.srcRow]) };
      }
      case 'slots': {
        const list = Array.from(App.slots.values());
        return { name: '盘位现状', headers: ['工站', '机柜', '设备', '位号', '状态', 'SN', 'PN', '型号', '工单', '结果', '错误码', '开始时间', '结束时间', '来源'],
          rows: list.map(s => [s.station, s.cabinetId, s.equipmentId, s.slotIndex + 1,
            L.slotState(s.state), s.sn, s.pn, s.model, s.woNo, L.result(s.result), s.errCode,
            s.startTime ? Util.fmtFull(s.startTime) : '',
            s.endTime ? Util.fmtFull(s.endTime) : '', L.source(s.source)]) };
      }
      case 'wo': {
        return { name: '工单', headers: ['工单号', '订单号', '料号', '机型', '客户', '数量', '状态', '工序链', '接单人', '接单时间', '结单人', '结单时间', '创建时间'],
          rows: (App.workOrders || []).map(w => [w.no, w.orderNo, w.pn, w.model, w.customer,
            w.qty, L.woState(w.status),
            WorkOrder.processWithOrt(w.model || w.pn).join(' > '),
            w.acceptedBy, w.acceptedAt ? Util.fmtFull(w.acceptedAt) : '',
            w.closedBy, w.closedAt ? Util.fmtFull(w.closedAt) : '',
            Util.fmtFull(w.createdAt)]) };
      }
      case 'loglist': {
        return { name: '日志文件清单', headers: ['拉取时间', '工站', '文件名', '路径', '大小', '解析记录', '关键词命中'],
          rows: (App.logindex || []).map(x => [x.pulledAt ? Util.fmtFull(x.pulledAt) : '',
            x.station, x.name, x.path, x.size,
            x.parsed, Object.keys(x.hits || {}).map(k => k + '=' + x.hits[k]).join(' ')]) };
      }
      case 'realtime': {
        const rt = App.state.eqRuntime || {};
        const eqs = Topology.all(cfg).equipment;
        const rows = eqs.map(eq => {
          const r = rt[eq.id] || {};
          const fresh = r.checkedAt ? Util.freshness(r.checkedAt) : null;
          return [eq.station, eq.cabinetId || eq.zone || '', eq.id, eq.ip || '',
            r.power === 'on' ? '开机' : r.power === 'off' ? '关机' : '未知',
            r.testing ? '在测' : (r.power === 'on' ? '空闲' : ''),
            r.errorHint || (r.errorKind && r.errorKind !== 'none' ? r.errorKind : ''),
            r.hostname || '', r.latestLog || '',
            r.latestLogTime ? Util.fmtFull(r.latestLogTime) : '',
            fresh ? fresh.text : '未巡检',
            r.stale ? '沿用上轮' : '',
            r.source || ''];
        });
        return { name: '设备实时状态', headers: ['工站', '机柜', '设备编号', 'IP', '电源', '测试', '异常', '主机名', '最新日志', '日志时间', '数据新鲜度', '备注', '来源'],
          rows };
      }
      case 'errStats': {
        /* 多段式汇总 —— 没有固定表头，适合直接贴进周报 */
        const list = inScope((App.error || []).slice());
        const lines = [];
        const total = list.reduce((a, e) => a + (e.count || 1), 0);
        lines.push(['报错统计汇总', scopeName()]);
        lines.push(['生成时间', Util.nowStr()]);
        lines.push([]);
        lines.push(['总计条目', list.length]);
        lines.push(['累计次数', total]);
        lines.push(['待处理', list.filter(e => !e.handled).length]);
        lines.push([]);

        const group = (fn) => {
          const m = {};
          list.forEach(e => { const k = fn(e) || '(未知)'; m[k] = (m[k] || 0) + (e.count || 1); });
          return Object.keys(m).sort((a, b) => m[b] - m[a]).map(k => [k, m[k]]);
        };
        lines.push(['—— 按报错类型 ——']);
        group(e => e.type).forEach(r => lines.push(r));
        lines.push([]);
        lines.push(['—— 按工站 ——']);
        group(e => MatchEngine.normalizeStation(cfg, e.station) || e.station).forEach(r => lines.push(r));
        lines.push([]);
        lines.push(['—— 按位置（TOP 20）——']);
        group(e => (e.cabinetId || '') + ' ' + (e.equipmentId || '')).slice(0, 20).forEach(r => lines.push(r));
        lines.push([]);
        lines.push(['—— 按错误码 ——']);
        group(e => e.errCode || '(无错误码)').slice(0, 20).forEach(r => lines.push(r));
        lines.push([]);
        lines.push(['—— 按日期 ——']);
        group(e => e.day).sort().forEach(r => lines.push(r));
        return { name: '报错统计', headers: null, rows: lines };
      }
      default:
        return null;
    }
  }

  /* --------------------------------------------------------------------------
     图表导出：把图表渲染进隐藏容器，取出 SVG 导出 PNG
     这样不必要求用户先切到那个视图
     -------------------------------------------------------------------------- */
  function exportChart(key) {
    const cfg = App.cfg;
    let html = '', filename = '';
    try {
      if (key === 'chartCapacity') {
        const ov = Capacity.overview(cfg);
        html = Charts.barH(ov.rows.map(r => ({
          label: r.name, value: Math.round(r.daily), color: r.color
        })), { title: '各工序理论日产能（块/天）' });
        filename = '各工序产能';
      } else if (key === 'chartOccupancy') {
        const topo = Topology.all(cfg);
        html = Charts.barH(Topology.summary(cfg).map(s => {
          const c = SlotGrid.countStates(topo.stationsMap[s.station] || [], App.slots);
          return { label: s.name, value: Math.round(c.util * 100), color: s.color };
        }), { title: '盘位占用率（%）' });
        filename = '盘位占用';
      } else if (key === 'chartBadType') {
        const by = {};
        (App.bad || []).forEach(b => { by[b.type || '未分类'] = (by[b.type || '未分类'] || 0) + 1; });
        html = Charts.donut(Object.keys(by).map(k => ({ label: k, value: by[k] })),
          { title: '不良类型分布' });
        filename = '不良类型分布';
      } else if (key === 'chartErrTop') {
        const by = {};
        (App.error || []).forEach(e => { by[e.type || '未分类'] = (by[e.type || '未分类'] || 0) + (e.count || 1); });
        html = Charts.barH(Object.keys(by).sort((a, b) => by[b] - by[a]).slice(0, 10)
          .map(k => ({ label: k, value: by[k], color: 'var(--bad)' })), { title: '报错类型 TOP' });
        filename = '报错类型TOP';
      }
    } catch (e) {
      Toast.error('生成图表失败：' + e.message);
      return;
    }
    if (!html) { Toast.warn('无可导出的数据'); return; }

    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-9999px;top:0;width:900px';
    box.innerHTML = html;
    document.body.appendChild(box);
    const svg = box.querySelector('svg');
    if (!svg) {
      box.remove();
      Toast.warn('该图表没有可导出的图形数据');
      return;
    }
    try {
      Charts.exportPng(svg, filename + '_' + Util.tsTag() + '.png');
      Toast.ok('已导出 ' + filename + '.png');
    } finally {
      setTimeout(() => box.remove(), 500);
    }
  }

  /* --------------------------------------------------------------------------
     执行
     -------------------------------------------------------------------------- */
  async function run(key) {
    /* JSON 备份 */
    const backup = GROUPS[0].items.filter(i => i.key === key)[0];
    if (backup) {
      await Backup.download(key, App.cfg, { workOrders: App.workOrders || [] });
      return;
    }
    /* 图表 */
    if (/^chart/.test(key)) { exportChart(key); return; }

    /* CSV */
    if (key === 'judgements') {
      App.state.judgements = await Repo.query('judgements', null, { limit: 200000 });
    }
    if (key === 'realtime' && !App.devices.length) {
      Toast.warn('尚未导入设备台账，实时状态表将只含合成设备');
    }
    const def = buildCsv(key);
    if (!def) { Toast.warn('未知导出项：' + key); return; }
    if (!def.rows.length) { Toast.warn('「' + def.name + '」在' + scopeName() + '范围内没有数据'); return; }
    Util.download(def.name + '_' + scopeName() + '_' + Util.tsTag() + '.csv',
      Util.toCsv(def.headers, def.rows));
    Toast.ok('已导出 ' + def.name + ' ' + Util.num(def.rows.length) + ' 行');
  }

  function bind(h) {
    h.el.addEventListener('click', async e => {
      const sc = e.target.closest('[data-exp-scope]');
      if (sc) { _scope = sc.dataset.expScope; h.close(); open(); return; }

      const btn = e.target.closest('[data-exp]');
      if (btn) { await run(btn.dataset.exp); return; }

      if (e.target.closest('#expImport')) {
        const mode = await Modal.confirm({
          title: '导入备份',
          html: '选择导入方式：<br><br>' +
                '<b>合并</b> —— 保留现有数据，按幂等键去重（推荐，安全）<br>' +
                '<b>替换</b> —— 清空现有数据后导入（适合换电脑恢复）',
          okText: '替换导入', cancelText: '合并导入'
        });
        const r = await Backup.pickAndImport(App.cfg, mode ? 'replace' : 'merge');
        if (r) {
          App.invalidate();
          await App.loadAll();
          Topology.setRegistry(App.devices.length ? App.devices : null);
          App.refreshStatus();
          h.close();
          App.switchView(App.state.curView);
          Toast.ok('导入完成：盘位 ' + Util.num(r.slots) + ' · 记录 ' + Util.num(r.records) +
                   ' · 不良 ' + Util.num(r.bad) + ' · 报错 ' + Util.num(r.error), '导入成功');
          if (r.warnings && r.warnings.length) {
            Modal.open({
              title: '导入警告', size: 'normal',
              body: r.warnings.map(w => '<div class="note warn">' + Util.esc(w) + '</div>').join(''),
              footer: '<button class="btn" data-mclose="1">知道了</button>'
            });
          }
        }
        return;
      }

      if (e.target.closest('#expClear')) {
        const ok1 = await Modal.confirm({
          title: '清空全部数据',
          html: '将删除<b>全部盘位、测试记录、不良、报错、工单、设备台账</b>，不可撤销。<br><br>' +
                '请确认已导出备份。',
          okText: '我已备份，继续', danger: true
        });
        if (!ok1) return;
        const typed = await Modal.prompt({
          title: '再次确认',
          text: '输入 CLEAR 以确认清空',
          hint: '这是最后一道确认。清空后只能靠导出的 JSON 恢复。'
        });
        if (typed !== 'CLEAR') { Toast.warn('输入不匹配，已取消'); return; }
        await Repo.clearAll();
        App.invalidate();
        await App.loadAll();
        Topology.setRegistry(null);
        App.refreshStatus();
        h.close();
        App.switchView(App.state.curView);
        Toast.ok('已清空全部数据');
      }
    });
  }

  /* list() / buildCsv() 暴露出来：一是便于测试逐项校验，
     二是将来做「定时自动导出」时可以直接复用，不必走界面。 */
  return { open, run, list: () => GROUPS, buildCsv, scope: (v) => { if (v) _scope = v; return _scope; } };
})();

/* ==========================================================================
   系统设置
   ========================================================================== */
const ModalSettings = (() => {

  /* MES 端点：配置里存的是 {名称: 路径}，界面上用「名称 = 路径」逐行编辑 */
  function mesEndpointsText(cfg) {
    const eps = (cfg.channels.webapp || {}).endpoints || {};
    const keys = Object.keys(eps);
    if (!keys.length) return 'workorders = /api/workorder-options';
    return keys.map(k => k + ' = ' + eps[k]).join('\n');
  }
  function parseEndpoints(text) {
    const out = {};
    String(text || '').split(/\r?\n/).forEach(line => {
      const s = line.trim();
      if (!s || s[0] === '#') return;
      const i = s.indexOf('=');
      if (i < 0) return;
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (k && v) out[k] = v;
    });
    return out;
  }

  /* 扫描根目录编辑表 */
  function renderRoots() {
    const box = document.getElementById('cfgRoots');
    if (!box) return;
    const roots = App.cfg.scanRoots || [];
    box.innerHTML = roots.length
      ? '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th style="width:60px">启用</th><th>名称</th><th>路径</th><th style="width:120px">工站</th>' +
        '<th style="width:80px">类型</th><th style="width:60px"></th></tr></thead><tbody>' +
        roots.map((r, i) =>
          '<tr>' +
            '<td><input type="checkbox" data-root-en="' + i + '"' + (r.enabled ? ' checked' : '') + '></td>' +
            '<td><input class="form-input" data-root-name="' + i + '" value="' + Util.esc(r.name) + '"></td>' +
            '<td><input class="form-input mono" data-root-path="' + i + '" value="' + Util.esc(r.path) + '"></td>' +
            '<td><select class="form-select" data-root-station="' + i + '">' +
              '<option value="">—</option>' +
              Topology.effectiveStations(App.cfg).map(s =>
                '<option value="' + s.key + '"' + (r.station === s.key ? ' selected' : '') + '>' +
                s.name + '</option>').join('') +
            '</select></td>' +
            '<td><select class="form-select" data-root-kind="' + i + '">' +
              '<option value="log"' + (r.kind === 'log' ? ' selected' : '') + '>日志</option>' +
              '<option value="config"' + (r.kind === 'config' ? ' selected' : '') + '>配置</option>' +
            '</select></td>' +
            '<td><button class="btn xs danger" data-root-del="' + i + '">删</button></td>' +
          '</tr>').join('') +
        '</tbody></table></div>'
      : '<div class="empty-tip">尚未配置扫描根目录</div>';
  }

  function open() {
    const cfg = App.cfg;
    const stations = Topology.effectiveStations(cfg);
    const ov = Capacity.overview(cfg);

    Modal.open({
      id: 'settings',
      title: '系统设置',
      sub: '工站配置 · 数据通道 · 节拍',
      size: 'wider',
      body:
        '<div class="section-title">工站配置' +
          '<span class="note-inline">改这里即可适配现场，不必改代码</span></div>' +
        '<div class="note">' +
          '设备数与单轮时长直接决定产能与瓶颈。<br>' +
          '⚠️ <b>FINAL 的 400 台</b>为需求方估计值，约为整线需求的 1.75 倍，建议现场核实后调整。' +
        '</div>' +
        DataTable.build([
          { key: 'name', label: '工站' },
          { key: 'unit', label: '单位' },
          { key: 'cap', label: '单台容量', cls: 'num', fmt: v => v.capacity },
          { key: 'count', label: '设备数', cls: 'num', html: (v, r) =>
              '<input type="number" class="form-input" style="width:80px;text-align:right" ' +
              'data-cfg-count="' + r.key + '" value="' + r.count + '" min="0">' },
          { key: 'cycle', label: '单轮时长(分钟)', cls: 'num', html: (v, r) =>
              '<input type="number" class="form-input" style="width:100px;text-align:right" ' +
              'data-cfg-cycle="' + r.key + '" value="' + r.cycleMin + '" min="0.1" step="any">' },
          { key: 'online', label: '同时在线', cls: 'num', fmt: (v, r) => Util.num(r.count * r.capacity) },
          { key: 'daily', label: '理论日产能', cls: 'num', fmt: (v, r) =>
              Util.num(Math.round(r.count * r.capacity * (1440 / r.cycleMin))) }
        ], stations) +
        '<div class="toolbar" style="margin-top:9px">' +
          '<button class="btn primary" id="cfgSave">保存工站配置</button>' +
          '<button class="btn" id="cfgReset">恢复默认</button>' +
          '<span class="hint" style="margin:0">当前瓶颈：<b>' +
            (ov.bottleneck ? ov.bottleneck.name : '--') + '</b></span>' +
        '</div>' +

        '<div class="section-title">数据通道</div>' +
        '<div class="settings-card">' +
          '<div class="settings-card-title">桥接服务地址</div>' +
          '<div class="desc">浏览器无法直接建立 FTP / SSH 连接，必须经本地桥接服务转发。' +
            'Python 桥接将在阶段 3 交付。</div>' +
          '<input class="form-input" id="cfgBridge" value="' +
            Util.esc((cfg.channels.ftp || {}).bridgeUrl || '') + '" placeholder="http://127.0.0.1:8770">' +
        '</div>' +

        '<div class="settings-card">' +
          '<div class="settings-card-title">SSH 巡检</div>' +
          '<div class="desc">定时只读巡检机台状态（开机/关机/在测），用于平面图实时状态。' +
            '密码只存在桥接侧，不进浏览器。</div>' +
          '<div class="form-row-3">' +
            '<div class="form-group"><label class="form-label">用户名</label>' +
              '<input class="form-input" id="cfgSshUser" value="' +
                Util.esc((cfg.channels.ssh || {}).user || '') + '"></div>' +
            '<div class="form-group"><label class="form-label">端口</label>' +
              '<input type="number" class="form-input" id="cfgSshPort" value="' +
                ((cfg.channels.ssh || {}).port || 22) + '"></div>' +
            '<div class="form-group"><label class="form-label">日志根目录</label>' +
              '<input class="form-input" id="cfgSshRoot" value="' +
                Util.esc((cfg.channels.ssh || {}).logRoot || '') + '"></div>' +
          '</div>' +
        '</div>' +

        '<div class="settings-card">' +
          '<div class="settings-card-title">FTP 日志服务器</div>' +
          '<div class="form-row-3">' +
            '<div class="form-group"><label class="form-label">主机</label>' +
              '<input class="form-input" id="cfgFtpHost" value="' +
                Util.esc((cfg.channels.ftp || {}).host || '') + '"></div>' +
            '<div class="form-group"><label class="form-label">端口</label>' +
              '<input type="number" class="form-input" id="cfgFtpPort" value="' +
                ((cfg.channels.ftp || {}).port || 21) + '"></div>' +
            '<div class="form-group"><label class="form-label">日志根路径</label>' +
              '<input class="form-input" id="cfgFtpBase" value="' +
                Util.esc((cfg.channels.ftp || {}).basePath || '') + '"></div>' +
          '</div>' +
          '<div class="hint">FTP 账号密码请填在桥接服务的 config 文件里，不要写在页面上。</div>' +
        '</div>' +

        '<div class="settings-card">' +
          '<div class="settings-card-title">MES 系统接口</div>' +
          '<div class="desc">从 MES / 上位系统取工单与测试记录。' +
            '现场协议未定，因此做成<b>可配置的转发</b>：只按下面的地址与端点拼 URL，' +
            '响应原样返回，字段映射后续再配。</div>' +
          '<div class="form-row-3">' +
            '<div class="form-group"><label class="form-label">服务地址</label>' +
              '<input class="form-input" id="cfgMesUrl" placeholder="http://10.0.0.10:8080" value="' +
                Util.esc((cfg.channels.webapp || {}).baseUrl || '') + '"></div>' +
            '<div class="form-group"><label class="form-label">认证头</label>' +
              '<input class="form-input" id="cfgMesHeader" placeholder="Authorization" value="' +
                Util.esc((cfg.channels.webapp || {}).authHeader || 'Authorization') + '"></div>' +
            '<div class="form-group"><label class="form-label">令牌</label>' +
              '<input class="form-input" id="cfgMesToken" placeholder="留空表示不需要认证" value="' +
                Util.esc((cfg.channels.webapp || {}).token || '') + '"></div>' +
          '</div>' +
          '<div class="form-group" style="margin-top:9px">' +
            '<label class="form-label">端点（每行一条：名称 = 路径）</label>' +
            '<textarea class="form-textarea" id="cfgMesEps" style="min-height:70px">' +
              Util.esc(mesEndpointsText(cfg)) + '</textarea>' +
            '<div class="form-hint">名称是调用时用的标识，路径是相对服务地址的 URL。' +
              '例如 <code>workorders = /api/workorder-options</code></div>' +
          '</div>' +
        '</div>' +

        '<div class="settings-card">' +
          '<div class="settings-card-title">扫描根目录' +
            '<span class="note-inline">拉取时按这些路径找日志</span></div>' +
          '<div class="desc">每个根目录对应现场的一处日志存放位置。' +
            '关掉的不会被扫描。工站字段用于把日志归到对应工序。</div>' +
          '<div id="cfgRoots"></div>' +
          '<div class="toolbar" style="margin:9px 0 0">' +
            '<button class="btn sm" id="cfgRootAdd">新增根目录</button>' +
          '</div>' +
        '</div>' +

        '<div class="section-title">节拍与刷新</div>' +
        '<div class="form-row-3">' +
          '<div class="form-group"><label class="form-label">拉取间隔（秒）</label>' +
            '<input type="number" class="form-input" id="cfgRefresh" value="' +
              (cfg.settings.refreshSec || 60) + '"></div>' +
          '<div class="form-group"><label class="form-label">单轮最多拉取文件数</label>' +
            '<input type="number" class="form-input" id="cfgMaxFiles" value="' +
              (cfg.settings.maxFilesPerRun || 80) + '"></div>' +
          '<div class="form-group"><label class="form-label">原始日志留档天数</label>' +
            '<input type="number" class="form-input" id="cfgKeepRaw" value="' +
              (cfg.settings.keepRawDays || 30) + '"></div>' +
        '</div>' +

        '<div class="section-title">存储信息</div>' +
        '<div id="storageInfo"></div>' +
        '<div class="toolbar" style="margin-top:9px">' +
          '<button class="btn" id="cfgExportConfig">导出配置</button>' +
          '<button class="btn danger" id="cfgResetAll">恢复出厂设置</button>' +
        '</div>',
      footer: '<button class="btn" data-mclose="1">关闭</button>' +
              '<button class="btn primary" id="cfgSaveAll">保存设置</button>',
      onMount(h) {
        renderStorageInfo(h);
        renderRoots();
        h.el.addEventListener('click', async e => {
          /* 扫描根目录：增 / 删 */
          if (e.target.closest('#cfgRootAdd')) {
            App.cfg.scanRoots = App.cfg.scanRoots || [];
            App.cfg.scanRoots.push({
              id: 'r_' + Util.uid('root'), name: '新目录', path: '', kind: 'log', enabled: false
            });
            renderRoots();
            return;
          }
          const del = e.target.closest('[data-root-del]');
          if (del) {
            const i = Number(del.dataset.rootDel);
            App.cfg.scanRoots.splice(i, 1);
            renderRoots();
            return;
          }
          if (e.target.closest('#cfgSave') || e.target.closest('#cfgSaveAll')) {
            saveAll(h);
            return;
          }
          if (e.target.closest('#cfgReset')) {
            const ok = await Modal.confirm({
              title: '恢复默认工站配置', text: '将把设备数与单轮时长恢复为规范中的出厂值。',
              okText: '恢复', danger: true
            });
            if (!ok) return;
            App.cfg.stationOverride = {};
            LocalStore.save();
            Topology.invalidate();
            h.close(); open();
            App.switchView(App.state.curView);
            Toast.ok('已恢复默认工站配置');
            return;
          }
          if (e.target.closest('#cfgExportConfig')) {
            await Backup.download('config', App.cfg);
            return;
          }
          if (e.target.closest('#cfgResetAll')) {
            const ok = await Modal.confirm({
              title: '恢复出厂设置',
              html: '将清空<b>全部设置与规则</b>并恢复到初始状态。<br>' +
                    '⚠️ 盘位与记录数据<b>不受影响</b>，但判定规则会重置。',
              okText: '恢复', danger: true
            });
            if (!ok) return;
            LocalStore.reset();
            App.state.cfg = LocalStore.load();
            Topology.invalidate();
            h.close();
            App.switchView(App.state.curView);
            Toast.ok('已恢复出厂设置');
          }
        });
      }
    });
  }

  async function renderStorageInfo(h) {
    const el = h.query('#storageInfo');
    if (!el) return;
    const est = await Repo.estimate();
    el.innerHTML =
      '<div class="hint">' +
        '存储后端：<b>' + Util.esc(Repo.backendLabel()) + '</b>' +
        (Repo.isDegraded()
          ? '<br><span style="color:var(--warn)">⚠️ 当前为降级模式。' +
            '若页面以 file:// 打开，浏览器会禁用 IndexedDB。' +
            '改用桥接托管地址 <code>http://127.0.0.1:8770/</code> 可获得完整容量。</span>'
          : '') +
        '<br>已用：' + Util.bytes(est.usage) +
        (est.quota ? ' / ' + Util.bytes(est.quota) +
          '（' + (est.usedPct * 100).toFixed(1) + '%）' : '') +
        '<br>非空盘位：' + Util.num(App.slots.size) +
        ' / ' + Util.num(Topology.all(App.cfg).totalSlots) +
        '<br>记录：' + Util.num((App.records || []).length) +
        ' · 不良：' + Util.num((App.bad || []).length) +
        ' · 报错：' + Util.num((App.error || []).length) +
      '</div>';
  }

  function saveAll(h) {
    const cfg = App.cfg;
    /* 工站覆盖 */
    const ov = {};
    h.queryAll('[data-cfg-count]').forEach(inp => {
      const k = inp.dataset.cfgCount;
      ov[k] = ov[k] || {};
      ov[k].count = Number(inp.value);
    });
    h.queryAll('[data-cfg-cycle]').forEach(inp => {
      const k = inp.dataset.cfgCycle;
      ov[k] = ov[k] || {};
      ov[k].cycleMin = Number(inp.value);
    });
    // 与出厂值一致的就不必存
    Object.keys(ov).forEach(k => {
      const base = ST[k];
      if (!base) return;
      if (ov[k].count === base.count) delete ov[k].count;
      if (ov[k].cycleMin === base.cycleMin) delete ov[k].cycleMin;
      if (!Object.keys(ov[k]).length) delete ov[k];
    });
    cfg.stationOverride = ov;

    /* 通道 */
    cfg.channels.ftp = cfg.channels.ftp || {};
    cfg.channels.ftp.bridgeUrl = h.query('#cfgBridge').value.trim();
    cfg.channels.ftp.host = h.query('#cfgFtpHost').value.trim();
    cfg.channels.ftp.port = Number(h.query('#cfgFtpPort').value) || 21;
    cfg.channels.ftp.basePath = h.query('#cfgFtpBase').value.trim();

    cfg.channels.ssh = cfg.channels.ssh || {};
    cfg.channels.ssh.user = h.query('#cfgSshUser').value.trim();
    cfg.channels.ssh.port = Number(h.query('#cfgSshPort').value) || 22;
    cfg.channels.ssh.logRoot = h.query('#cfgSshRoot').value.trim();

    /* MES 通道 */
    cfg.channels.webapp = cfg.channels.webapp || {};
    cfg.channels.webapp.baseUrl = (h.query('#cfgMesUrl').value || '').trim();
    cfg.channels.webapp.authHeader = (h.query('#cfgMesHeader').value || '').trim() || 'Authorization';
    cfg.channels.webapp.token = (h.query('#cfgMesToken').value || '').trim();
    cfg.channels.webapp.endpoints = parseEndpoints(h.query('#cfgMesEps').value);

    /* 扫描根目录：从表格里逐个读回 */
    const roots = cfg.scanRoots || [];
    roots.forEach((r, i) => {
      const en = document.querySelector('[data-root-en="' + i + '"]');
      const nm = document.querySelector('[data-root-name="' + i + '"]');
      const pa = document.querySelector('[data-root-path="' + i + '"]');
      const st = document.querySelector('[data-root-station="' + i + '"]');
      const kd = document.querySelector('[data-root-kind="' + i + '"]');
      if (en) r.enabled = en.checked;
      if (nm) r.name = nm.value.trim();
      if (pa) r.path = pa.value.trim();
      if (st) r.station = st.value;
      if (kd) r.kind = kd.value;
    });
    // 丢掉路径为空的空行
    cfg.scanRoots = roots.filter(r => r.path);

    /* 节拍 */
    cfg.settings.refreshSec = Number(h.query('#cfgRefresh').value) || 60;
    cfg.settings.maxFilesPerRun = Number(h.query('#cfgMaxFiles').value) || 80;
    cfg.settings.keepRawDays = Number(h.query('#cfgKeepRaw').value) || 30;

    const r = LocalStore.save();
    Topology.invalidate();

    if (!r.ok) {
      Toast.error('配置保存失败' + (r.reason === 'quota' ? '（存储空间不足）' : ''));
      return;
    }
    h.close();
    App.refreshStatus();
    App.switchView(App.state.curView);
    Toast.ok('设置已保存');
  }

  return { open };
})();
