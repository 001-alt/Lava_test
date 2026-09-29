/* ============================================================================
   关键词高亮与日志扫描
   ----------------------------------------------------------------------------
   对应 RDIMM 的 logScanKeywords / logHighlight / woKeywordRules。
   规则可在「日志分析 → 规则」里配置；为空则用内置默认。
   ============================================================================ */

const Highlight = (() => {

  const DEFAULT_RULES = [
    { key: 'PASS',     name: '通过',       re: '\\bPASS\\b' },
    { key: 'FAIL',     name: '失败',       re: '\\bFAIL\\b' },
    { key: 'ERROR',    name: '错误',       re: '\\bERR(OR)?\\b' },
    { key: 'SN',       name: '序列号',     re: '\\bSN\\b\\s*[:=]' },
    { key: 'STATION',  name: '工站',       re: '\\b(Station|工站)\\b\\s*[:=]' },
    { key: 'TIMEOUT',  name: '超时',       re: '(超时|timeout)' },
    { key: 'RETRY',    name: '重试',       re: '(重试|retry)' },
    { key: 'TEMP',     name: '温度异常',   re: '(温度|Temp).{0,12}(超|高|fail|异常)' },
    { key: 'ECC',      name: 'ECC',        re: '\\b(CE|UCE|ECC)\\b' },
    { key: 'DONE',     name: '完成',       re: '\\b(Done|Finished|完成)\\b' }
  ];

  function rules(cfg) {
    const custom = (cfg && cfg.woKeywordRules) || [];
    return custom.length ? custom : DEFAULT_RULES;
  }

  /* 逐行 × 逐规则扫描 */
  function scan(cfg, text, maxHits) {
    const limit = maxHits || 500;
    const lines = String(text || '').split(/\r?\n/);
    const rs = rules(cfg);
    const hits = [];
    const summary = {};
    const compiled = rs.map(r => {
      try { return { key: r.key, name: r.name, re: new RegExp(r.re, 'i') }; }
      catch (e) { return null; }   // 非法正则跳过，不影响其它规则
    }).filter(Boolean);

    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      const line = lines[i];
      if (!line) continue;
      for (let k = 0; k < compiled.length; k++) {
        const r = compiled[k];
        if (r.re.test(line)) {
          hits.push({ key: r.key, name: r.name, line: i + 1, text: Util.truncate(line.trim(), 220) });
          summary[r.key] = (summary[r.key] || 0) + 1;
          break;   // 一行只记首个命中的规则，避免重复计数
        }
      }
    }
    return { hits, summary, total: hits.length, lineCount: lines.length };
  }

  /* HTML 转义 + 关键词包裹 <mark> */
  function render(cfg, text) {
    const out = Util.esc(text);
    const rs = rules(cfg);
    let html = out;
    rs.forEach(r => {
      try {
        const re = new RegExp('(' + r.re + ')', 'gi');
        html = html.replace(re, '<mark>$1</mark>');
      } catch (e) { }
    });
    return html;
  }

  /* 命中列表（点击可定位到原文行） */
  function hitsHtml(hits) {
    if (!hits || !hits.length) return '<div class="empty-tip">未命中任何关键词</div>';
    return '<div class="log-hits">' + hits.map(h =>
      '<div class="log-hit kw-' + Util.esc(h.key) + '" data-log-line="' + h.line + '">' +
        '<span class="ln">' + h.line + '</span>' +
        '<span class="tx" title="' + Util.escAttr(h.text) + '">' +
          '<span style="color:var(--tx-3)">[' + Util.esc(h.name) + ']</span> ' +
          Util.esc(h.text) + '</span>' +
      '</div>').join('') + '</div>';
  }

  return { DEFAULT_RULES, rules, scan, render, hitsHtml };
})();
