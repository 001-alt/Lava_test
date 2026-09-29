/* ============================================================================
   图表 —— 手写 SVG，零外部依赖
   ----------------------------------------------------------------------------
   为什么不用 ECharts：
     RDIMM 从 jsdelivr CDN 加载 ECharts，现场断网即失效（其源码解析 §10 已列为缺陷）；
     改为本地打包又要多 1MB。本项目只需要柱状/折线/环形三种图，
     手写 SVG 约 200 行即可覆盖，且打包后仍 < 20KB、离线可用、可导出 PNG。
   ============================================================================ */

const Charts = (() => {

  const PALETTE = ['#4f8ef7', '#39d353', '#f0a500', '#f85149', '#d96ad9',
                   '#3fb6f0', '#12b5a5', '#f0883e'];

  function esc(s) { return Util.esc(s); }

  /* --------------------------------------------------------------------------
     横向柱状图
       data: [{ label, value, color?, sub? }]
     -------------------------------------------------------------------------- */
  function barH(data, opts) {
    const o = opts || {};
    const items = data || [];
    if (!items.length) return '<div class="empty-tip">暂无数据</div>';
    const max = Math.max.apply(null, items.map(x => x.value).concat([1]));
    return '<div class="bar-chart">' +
      (o.title ? '<div style="font-size:12.5px;font-weight:600;margin-bottom:12px">' +
        esc(o.title) + '</div>' : '') +
      items.map((x, i) => {
        const pct = (x.value / max * 100).toFixed(1);
        const color = x.color || PALETTE[i % PALETTE.length];
        const valText = o.fmt ? o.fmt(x.value, x) : Util.num(Math.round(x.value));
        return '<div class="bar-row">' +
          '<div class="bn"><i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' +
            color + '"></i>' + esc(x.label) + (x.tag || '') + '</div>' +
          '<div class="bt"><i style="width:' + pct + '%;background:' + color + '"></i></div>' +
          '<div class="bv">' + valText + '</div>' +
        '</div>';
      }).join('') +
      (o.note ? '<div class="hint" style="margin:11px 0 0">' + o.note + '</div>' : '') +
    '</div>';
  }

  /* --------------------------------------------------------------------------
     纵向柱状图（按天趋势）
       data: [{ label, value }]
     -------------------------------------------------------------------------- */
  function barV(data, opts) {
    const o = opts || {};
    const items = data || [];
    if (!items.length) return '<div class="empty-tip">暂无数据</div>';
    const max = Math.max.apply(null, items.map(x => x.value).concat([1]));
    const W = 100, H = 46;                 // 用百分比坐标，容器自适应
    const bw = W / items.length;
    const bars = items.map((x, i) => {
      const h = (x.value / max) * (H - 8);
      const xPos = i * bw + bw * 0.18;
      const w = bw * 0.64;
      return '<rect x="' + xPos.toFixed(2) + '" y="' + (H - h).toFixed(2) +
             '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) +
             '" rx="0.6" fill="' + (x.color || PALETTE[0]) + '">' +
             '<title>' + esc(x.label) + ': ' + Util.num(x.value) + '</title></rect>';
    }).join('');
    const labels = items.map((x, i) =>
      i % (items.length > 14 ? 3 : 1) === 0
        ? '<text x="' + (i * bw + bw / 2).toFixed(2) + '" y="' + (H + 3).toFixed(2) +
          '" font-size="2.6" fill="#67748a" text-anchor="middle">' + esc(x.label) + '</text>'
        : ''
    ).join('');

    return '<div class="bar-chart">' +
      (o.title ? '<div style="font-size:12.5px;font-weight:600;margin-bottom:10px">' +
        esc(o.title) + '</div>' : '') +
      '<svg viewBox="0 0 100 ' + (H + 6) + '" preserveAspectRatio="none" ' +
        'style="width:100%;height:150px;overflow:visible">' + bars + labels + '</svg>' +
      (o.note ? '<div class="hint" style="margin:6px 0 0">' + o.note + '</div>' : '') +
    '</div>';
  }

  /* --------------------------------------------------------------------------
     折线图
     -------------------------------------------------------------------------- */
  function line(data, opts) {
    const o = opts || {};
    const items = data || [];
    if (items.length < 2) return '<div class="empty-tip">数据点不足</div>';
    const max = Math.max.apply(null, items.map(x => x.value).concat([1]));
    const W = 100, H = 42;
    const step = W / (items.length - 1);
    const pts = items.map((x, i) =>
      (i * step).toFixed(2) + ',' + (H - (x.value / max) * (H - 6) - 2).toFixed(2));
    const path = 'M' + pts.join(' L');
    const area = path + ' L' + W + ',' + H + ' L0,' + H + ' Z';
    const dots = items.map((x, i) =>
      '<circle cx="' + (i * step).toFixed(2) + '" cy="' +
      (H - (x.value / max) * (H - 6) - 2).toFixed(2) + '" r="0.9" fill="' +
      (o.color || PALETTE[0]) + '"><title>' + esc(x.label) + ': ' + Util.num(x.value) +
      '</title></circle>').join('');
    const labels = items.map((x, i) =>
      i % (items.length > 10 ? 2 : 1) === 0
        ? '<text x="' + (i * step).toFixed(2) + '" y="' + (H + 4) + '" font-size="2.6" ' +
          'fill="#67748a" text-anchor="middle">' + esc(x.label) + '</text>'
        : '').join('');

    return '<div class="bar-chart">' +
      (o.title ? '<div style="font-size:12.5px;font-weight:600;margin-bottom:10px">' +
        esc(o.title) + '</div>' : '') +
      '<svg viewBox="0 0 100 ' + (H + 6) + '" preserveAspectRatio="none" ' +
        'style="width:100%;height:150px;overflow:visible">' +
        '<path d="' + area + '" fill="' + (o.color || PALETTE[0]) + '" opacity="0.13"/>' +
        '<path d="' + path + '" fill="none" stroke="' + (o.color || PALETTE[0]) +
          '" stroke-width="1.1" stroke-linejoin="round"/>' +
        dots + labels +
      '</svg>' +
    '</div>';
  }

  /* --------------------------------------------------------------------------
     环形图（占比）
     -------------------------------------------------------------------------- */
  function donut(data, opts) {
    const o = opts || {};
    const items = (data || []).filter(x => x.value > 0);
    const total = items.reduce((a, x) => a + x.value, 0);
    if (!total) return '<div class="empty-tip">暂无数据</div>';

    const R = 15.9155;     // 使周长恰好为 100，便于按百分比画弧
    let offset = 0;
    const arcs = items.map((x, i) => {
      const pct = x.value / total * 100;
      const seg = '<circle cx="21" cy="21" r="' + R + '" fill="none" ' +
        'stroke="' + (x.color || PALETTE[i % PALETTE.length]) + '" stroke-width="6" ' +
        'stroke-dasharray="' + pct.toFixed(3) + ' ' + (100 - pct).toFixed(3) + '" ' +
        'stroke-dashoffset="' + (-offset).toFixed(3) + '">' +
        '<title>' + esc(x.label) + ': ' + Util.num(x.value) + ' (' + pct.toFixed(1) + '%)</title></circle>';
      offset += pct;
      return seg;
    }).join('');

    return '<div class="bar-chart" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">' +
      '<svg viewBox="0 0 42 42" style="width:132px;height:132px;flex:none;' +
        'transform:rotate(-90deg)">' +
        '<circle cx="21" cy="21" r="' + R + '" fill="none" stroke="#232c38" stroke-width="6"/>' +
        arcs +
      '</svg>' +
      '<div style="flex:1;min-width:150px">' +
        (o.title ? '<div style="font-size:12.5px;font-weight:600;margin-bottom:9px">' +
          esc(o.title) + '</div>' : '') +
        items.map((x, i) =>
          '<div style="display:flex;align-items:center;gap:7px;font-size:11.5px;margin-bottom:5px">' +
            '<i style="width:9px;height:9px;border-radius:2px;background:' +
              (x.color || PALETTE[i % PALETTE.length]) + '"></i>' +
            '<span style="flex:1">' + esc(x.label) + '</span>' +
            '<span style="color:var(--tx-2)">' + Util.num(x.value) + '</span>' +
            '<span style="color:var(--tx-3);min-width:44px;text-align:right">' +
              (x.value / total * 100).toFixed(1) + '%</span>' +
          '</div>').join('') +
      '</div>' +
    '</div>';
  }

  /* --------------------------------------------------------------------------
     把 SVG 图导出为 PNG（无需外部库，走 canvas 重绘）
     -------------------------------------------------------------------------- */
  function exportPng(svgEl, filename) {
    if (!svgEl) { Toast.warn('未找到图表'); return; }
    const clone = svgEl.cloneNode(true);
    // 内联底色，避免导出后透明
    const vbox = (svgEl.getAttribute('viewBox') || '0 0 100 50').split(/\s+/);
    const w = 1000, h = Math.round(w * (Number(vbox[3]) / Number(vbox[2])) || 300);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    clone.style.background = '#0d1117';
    const svgStr = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      const dpr = 2;
      canvas.width = w * dpr; canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => {
        Util.download(filename || ('chart_' + Util.tsTag() + '.png'), b, 'image/png');
      }, 'image/png');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      Toast.error('图表导出失败');
    };
    img.src = url;
  }

  return { barH, barV, line, donut, exportPng, PALETTE };
})();
