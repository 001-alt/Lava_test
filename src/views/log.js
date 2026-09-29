/* ============================================================================
   日志分析 —— 关键词扫描、高亮、定位原始行、规则可配置
   ============================================================================ */

const ViewLog = (() => {

  let _cur = null;      // 当前扫描结果
  let _text = '';       // 当前日志正文

  async function render() {
    await App.ensureRecords('logindex');
    const idx = App.logindex || [];
    const rules = Highlight.rules(App.cfg);

    Dom.html('logBody',
      '<div class="toolbar">' +
        '<span class="title">日志分析</span>' +
        '<select class="form-select" id="logPick" style="width:380px">' +
          '<option value="">— 选择已拉取的日志文件 —</option>' +
          idx.map(l => '<option value="' + Util.esc(l.path) + '">' +
            Util.esc(l.station + ' · ' + l.name) + '</option>').join('') +
        '</select>' +
        '<button class="btn" id="btnLogAnalyze">分析</button>' +
        '<button class="btn" id="btnLogRules">关键词规则 (' + rules.length + ')</button>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn" id="btnLogExport">导出</button>' +
      '</div>' +

      '<div class="note">' +
        '可直接把日志文本粘贴到下面的输入框分析，无需先接入数据源。' +
        '关键词规则可在「关键词规则」里配置 —— 每行一条 <code>名称 | 正则</code>，清空即恢复默认。' +
      '</div>' +

      '<div class="form-group" style="margin-bottom:12px">' +
        '<label class="form-label">日志正文（粘贴或从上方选择文件）</label>' +
        '<textarea class="form-textarea" id="logInput" style="min-height:150px" ' +
          'placeholder="把测试日志粘贴到这里，然后点「分析」"></textarea>' +
      '</div>' +

      '<div id="logStat"></div>' +
      '<div id="logHits"></div>' +
      '<div id="logContentBox"></div>'
    );
  }

  function analyze(text, sourceName) {
    _text = text || '';
    if (!_text.trim()) { Toast.warn('日志内容为空'); return; }
    const r = Highlight.scan(App.cfg, _text, 800);
    _cur = r;

    const summaryRows = Object.keys(r.summary).map(k => {
      const rule = Highlight.rules(App.cfg).filter(x => x.key === k)[0] || {};
      return { key: k, name: rule.name || k, count: r.summary[k] };
    }).sort((a, b) => b.count - a.count);

    Dom.html('logStat',
      '<div class="cards">' +
        '<div class="card"><div class="lbl">日志行数</div>' +
          '<div class="val">' + Util.num(r.lineCount) + '</div></div>' +
        '<div class="card"><div class="lbl">命中行数</div>' +
          '<div class="val" style="color:var(--warn)">' + Util.num(r.total) + '</div>' +
          '<div class="sub">' + (r.lineCount ? (r.total / r.lineCount * 100).toFixed(1) : 0) + '% 的行命中关键词</div></div>' +
        (summaryRows.slice(0, 3).map(x =>
          '<div class="card"><div class="lbl">' + Util.esc(x.name) + '</div>' +
          '<div class="val">' + Util.num(x.count) + '</div></div>').join('')) +
      '</div>' +
      (sourceName ? '<div class="hint">来源：' + Util.esc(sourceName) + '</div>' : '')
    );

    Dom.html('logHits',
      '<div class="section-title">命中明细' +
        '<span class="note-inline">点击行号可定位到原文</span></div>' +
      Highlight.hitsHtml(r.hits));

    Dom.html('logContentBox',
      '<div class="section-title">原文（高亮）</div>' +
      '<div class="log-view" id="logContent">' + Highlight.render(App.cfg, _text) + '</div>'
    );
  }

  /* 关键词规则编辑 */
  async function editRules() {
    const cur = (App.cfg.woKeywordRules || []);
    const text = cur.length
      ? cur.map(r => r.name + ' | ' + r.re).join('\n')
      : Highlight.DEFAULT_RULES.map(r => r.name + ' | ' + r.re).join('\n');

    Modal.open({
      title: '关键词规则',
      size: 'wide',
      body:
        '<div class="hint">每行一条，格式：<code>名称 | 正则</code>。' +
        '留空保存即恢复内置默认规则。正则语法错误的那一行会被跳过，不影响其它规则。</div>' +
        '<textarea class="form-textarea" id="kwRules" style="min-height:280px">' +
          Util.esc(text) + '</textarea>' +
        '<div class="section-title">内置默认规则</div>' +
        DataTable.build([
          { key: 'key', label: '标识' },
          { key: 'name', label: '名称' },
          { key: 're', label: '正则', cls: 'col-sn' }
        ], Highlight.DEFAULT_RULES),
      footer: '<button class="btn" data-mclose="1">取消</button>' +
              '<button class="btn warn" id="kwReset">恢复默认</button>' +
              '<button class="btn primary" id="kwSave">保存</button>',
      onMount(h) {
        h.el.addEventListener('click', e => {
          if (e.target.closest('#kwReset')) {
            h.query('#kwRules').value = Highlight.DEFAULT_RULES.map(r => r.name + ' | ' + r.re).join('\n');
            return;
          }
          if (!e.target.closest('#kwSave')) return;
          const lines = h.query('#kwRules').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
          const bad = [];
          const rules = [];
          lines.forEach((ln, i) => {
            const p = ln.split('|');
            if (p.length < 2) { bad.push('第 ' + (i + 1) + ' 行格式不对'); return; }
            const name = p[0].trim();
            const re = p.slice(1).join('|').trim();
            try { new RegExp(re, 'i'); } catch (err) { bad.push('第 ' + (i + 1) + ' 行正则非法'); return; }
            rules.push({ key: 'K' + i, name, re });
          });
          if (bad.length) { Toast.warn(bad.slice(0, 3).join('；')); return; }
          App.cfg.woKeywordRules = rules;
          LocalStore.save();
          h.close();
          render();
          if (_text) analyze(_text);
          Toast.ok('已保存 ' + rules.length + ' 条规则');
        });
      }
    });
  }

  function exportResult() {
    if (!_cur) { Toast.warn('请先分析日志'); return; }
    const rows = _cur.hits.map(h => [h.line, h.name, h.key, h.text]);
    Util.download('日志分析_' + Util.tsTag() + '.csv', Util.toCsv(
      ['行号', '关键词', '标识', '内容'], rows));
    Toast.ok('已导出 ' + rows.length + ' 条命中');
  }

  function bind() {
    Dom.delegate('logBody', 'click', '#btnLogAnalyze', () => {
      analyze(document.getElementById('logInput').value, '手工粘贴');
    });

    Dom.delegate('logBody', 'change', '#logPick', async (e, el) => {
      const path = el.value;
      if (!path) return;
      const rec = (App.logindex || []).filter(l => l.path === path)[0];
      /* 日志正文需要从数据源读取；当前未接入时给出提示并展示索引里的摘要 */
      Toast.info('日志正文需从数据源读取。已接入 SSH / FTP / 本地目录后可直接拉取全文。');
      if (rec) {
        const stub = '（演示内容）日志索引：' + rec.name + '\n' +
          '工站：' + rec.station + '\n' +
          '大小：' + Util.bytes(rec.size) + '\n' +
          '解析记录：' + rec.parsed + ' 条\n' +
          '关键词命中：' + Object.keys(rec.hits || {}).map(k => k + '=' + rec.hits[k]).join(', ') + '\n\n' +
          '接入真实数据源后，此处会显示日志全文并支持关键词高亮定位。';
        document.getElementById('logInput').value = stub;
        analyze(stub, rec.name);
      }
    });

    Dom.delegate('logBody', 'click', '#btnLogRules', editRules);
    Dom.delegate('logBody', 'click', '#btnLogExport', exportResult);

    /* 点击命中行 → 滚动到原文对应行 */
    Dom.delegate('logBody', 'click', '[data-log-line]', (e, el) => {
      const line = Number(el.dataset.logLine);
      const box = document.getElementById('logContent');
      if (!box) return;
      const lines = box.innerHTML.split('\n');
      if (line > 0 && line <= lines.length) {
        /* 高亮目标行：用等宽字号估算滚动位置 */
        const total = lines.length;
        box.scrollTop = (line / total) * box.scrollHeight - box.clientHeight / 3;
      }
    });
  }

  return { render, bind, analyze };
})();
