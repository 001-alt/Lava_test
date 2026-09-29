/* ============================================================================
   表格构建 —— 统一列定义、渲染、分页、导出
   ----------------------------------------------------------------------------
   各视图不再各写一遍 innerHTML 拼表，避免 RDIMM 里「两套 CSV 导出实现并存」
   那种列契约不一致的问题。列定义即导出的表头来源。
   ============================================================================ */

const DataTable = (() => {

  /* 列定义：
     { key, label, width, cls, fmt(v,row), html(v,row), csv(v,row), hide }
     fmt 返回文本，html 返回 HTML（优先），csv 返回导出值 */
  function build(cols, rows, opts) {
    const o = opts || {};
    const vis = cols.filter(c => !c.hide);
    const head = vis.map(c =>
      '<th' + (c.width ? ' style="width:' + c.width + '"' : '') +
      (c.cls ? ' class="' + c.cls + '"' : '') + '>' + Util.esc(c.label) + '</th>'
    ).join('');

    if (!rows || !rows.length) {
      return '<div class="table-wrap"><table class="data-table"><thead><tr>' + head +
        '</tr></thead><tbody><tr><td colspan="' + vis.length +
        '" class="empty-tip">' + Util.esc(o.emptyText || '暂无数据') + '</td></tr></tbody></table></div>';
    }

    const body = rows.map((row, ri) => {
      const tds = vis.map(c => {
        let v = '';
        if (typeof c.html === 'function') v = c.html(row[c.key], row, ri);
        else if (typeof c.fmt === 'function') v = Util.esc(c.fmt(row[c.key], row, ri));
        else v = Util.esc(row[c.key] == null ? '' : row[c.key]);
        return '<td' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + v + '</td>';
      }).join('');
      const rowCls = typeof o.rowClass === 'function' ? o.rowClass(row, ri) : '';
      const rowAttr = typeof o.rowAttr === 'function' ? o.rowAttr(row, ri) : '';
      return '<tr' + (rowCls ? ' class="' + rowCls + '"' : '') + rowAttr + '>' + tds + '</tr>';
    }).join('');

    return '<div class="table-wrap"><table class="data-table">' +
      '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  /* 带分页的渲染：返回 {html, slice, page, pages}
     total 为总条数（可能是服务端计的数），rows 为当前页数据 */
  function paginated(cols, allRows, page, pageSize) {
    const size = pageSize || LocalStore.ui.get('tablePageSize', 100);
    const total = allRows.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const p = Util.clamp(page || 1, 1, pages);
    const slice = allRows.slice((p - 1) * size, p * size);
    const html = build(cols, slice);
    const pager = total > size
      ? '<div class="pager">' +
          '<span class="pg-info">共 ' + Util.num(total) + ' 条，第 ' + p + ' / ' + pages + ' 页</span>' +
          '<button class="btn sm" data-pg="first"' + (p <= 1 ? ' disabled' : '') + '>首页</button>' +
          '<button class="btn sm" data-pg="prev"' + (p <= 1 ? ' disabled' : '') + '>上一页</button>' +
          '<button class="btn sm" data-pg="next"' + (p >= pages ? ' disabled' : '') + '>下一页</button>' +
          '<button class="btn sm" data-pg="last"' + (p >= pages ? ' disabled' : '') + '>末页</button>' +
        '</div>'
      : (total ? '<div class="pager"><span class="pg-info">共 ' + Util.num(total) + ' 条</span></div>' : '');
    return { html: html + pager, slice, page: p, pages, total };
  }

  /* 处理分页按钮点击：返回新页码，无变化返回原值 */
  function handlePage(action, page, total, pageSize) {
    const size = pageSize || LocalStore.ui.get('tablePageSize', 100);
    const pages = Math.max(1, Math.ceil(total / size));
    if (action === 'first') return 1;
    if (action === 'last') return pages;
    if (action === 'prev') return Util.clamp(page - 1, 1, pages);
    if (action === 'next') return Util.clamp(page + 1, 1, pages);
    return page;
  }

  /* 按列定义导出 CSV —— 与界面同源，保证列契约一致 */
  function toCsv(cols, rows, opts) {
    const vis = cols.filter(c => !c.hide);
    const headers = vis.map(c => (opts && opts.headerPrefix ? opts.headerPrefix + c.label : c.label));
    const data = rows.map(row => vis.map(c => {
      if (typeof c.csv === 'function') return c.csv(row[c.key], row);
      if (typeof c.fmt === 'function') return c.fmt(row[c.key], row);
      return row[c.key];
    }));
    return Util.toCsv(headers, data, opts);
  }

  /* 内联迷你进度条 */
  function miniBar(pct, color) {
    const p = Util.clamp((pct || 0) * 100, 0, 100);
    const c = color || (p >= 95 ? 'var(--ok)' : p >= 60 ? 'var(--info)' : 'var(--warn)');
    return '<span class="mini-bar"><span class="track"><i style="width:' + p.toFixed(0) +
           '%;background:' + c + '"></i></span><span class="pct">' + p.toFixed(0) + '%</span></span>';
  }

  /* 汇总条（带占比） */
  function summaryList(items) {
    const max = items.reduce((a, x) => Math.max(a, x.value), 0) || 1;
    const total = items.reduce((a, x) => a + x.value, 0) || 1;
    return '<div class="summary-list">' + items.map(x =>
      '<div class="summary-item">' +
        '<span>' + Util.esc(x.label) + '</span>' +
        '<span class="track"><i style="width:' + (x.value / max * 100).toFixed(1) +
          '%;background:' + (x.color || 'var(--info)') + '"></i></span>' +
        '<span class="val">' + Util.num(x.value) + ' · ' +
          (x.value / total * 100).toFixed(1) + '%</span>' +
      '</div>').join('') + '</div>';
  }

  return { build, paginated, handlePage, toCsv, miniBar, summaryList };
})();
