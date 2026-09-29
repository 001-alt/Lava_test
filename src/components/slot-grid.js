/* ============================================================================
   盘位网格渲染器 —— 全项目最热的代码路径
   ----------------------------------------------------------------------------
   12,737 个盘位。实测生成 HTML 字符串只要 ~25ms，所以**字符串渲染不是瓶颈**，
   瓶颈是频繁重建 DOM。因此策略是：

     首屏：一次 innerHTML 全量渲染（快，且浏览器解析一次到位）
     刷新：**只 patch 变化的格**，不重建子树

   索引的建立不靠给 12,737 个格子挂 data 属性（会多出 ~350KB HTML），
   而是利用「querySelectorAll 返回文档序 == 我发射的顺序」这一点，
   按设备在盘位两重循环里顺序对齐，O(n) 且零属性开销。
   ============================================================================ */

const SlotGrid = (() => {

  /* 单元格的 title 提示 */
  function cellTitle(station, eq, slotIndex, rec) {
    const st = ST[station];
    const lines = [eq.id + ' · 位' + (slotIndex + 1)];
    if (!rec || rec.state === 'empty') {
      lines.push('空位');
    } else {
      lines.push(L.slotState(rec.state));
      if (rec.sn) lines.push('SN ' + rec.sn);
      if (rec.pn) lines.push('PN ' + rec.pn);
      if (rec.woNo) lines.push('工单 ' + rec.woNo);
      if (rec.errCode) lines.push('错误码 ' + rec.errCode);
      if (rec.state === 'testing' && rec.startTime && st) {
        const left = rec.startTime + st.cycleMin * 60000 - Date.now();
        lines.push('剩余 ' + Util.fmtDur(left));
      }
    }
    return lines.join('\n');
  }

  /* 单元格 class：状态类 + 待确认不良黄框 */
  function cellClass(rec, pendingBad) {
    const state = (rec && rec.state) || 'empty';
    let c = 'cell ' + ((SLOT_STATE[state] || SLOT_STATE.empty).cls);
    if (!rec || !rec.sn) c += ' no-sn';
    if (pendingBad) c += ' pending-bad';
    return c;
  }

  /* --------------------------------------------------------------------------
     渲染一整台设备的盘位网格（返回 HTML 串）
     -------------------------------------------------------------------------- */
  function gridHTML(station, eq, slotMap, opts) {
    const st = ST[station];
    const cap = eq.capacity;
    // 容量档位映射到 CSS 类：1 / 16 / 128 / 256
    const cls = cap >= 128 ? cap : (cap === 1 ? 1 : 16);
    const pendingSet = (opts && opts.pending) || null;

    let html = '<div class="slot-grid cap' + cls + '" data-eq="' + Util.esc(eq.id) + '">';
    for (let i = 0; i < cap; i++) {
      const key = eq.slotKeys[i];
      const rec = slotMap ? slotMap.get(key) : null;
      const title = cellTitle(station, eq, i, rec);
      // ICT 单格显示 SN 尾号，方便一眼认出是哪块
      const label = (cap === 1 && rec && rec.sn) ? Util.esc(String(rec.sn).slice(-6)) : '';
      html += '<div class="' + cellClass(rec, pendingSet && pendingSet.has(key)) + '"' +
              ' data-k="' + Util.esc(key) + '"' +
              ' title="' + Util.escAttr(title) + '">' + label + '</div>';
    }
    return html + '</div>';
  }

  /* --------------------------------------------------------------------------
     独立设备卡（ICT / BIST / ESS）
     -------------------------------------------------------------------------- */
  function flatCardHTML(station, eq, slotMap, eqState, opts) {
    const st = ST[station];
    let used = 0, testing = 0, fail = 0;
    for (let i = 0; i < eq.capacity; i++) {
      const rec = slotMap.get(eq.slotKeys[i]);
      if (!rec || rec.state === 'empty') continue;
      used++;
      if (rec.state === 'testing') testing++;
      else if (rec.state === 'fail') fail++;
    }
    // 当前在测的第一块，用于显示进度与剩余时间
    let cur = null;
    for (let i = 0; i < eq.capacity; i++) {
      const rec = slotMap.get(eq.slotKeys[i]);
      if (rec && rec.state === 'testing' && rec.startTime) { cur = rec; break; }
    }
    const pct = cur && st && st.cycleMin
      ? Util.clamp((Date.now() - cur.startTime) / (st.cycleMin * 60000), 0, 1) * 100
      : (eq.capacity ? used / eq.capacity * 100 : 0);
    const remain = cur && st ? (cur.startTime + st.cycleMin * 60000 - Date.now()) : 0;
    const es = EQ_STATE[eqState] || EQ_STATE.idle;

    return '<div class="eq ' + (eqState === 'fault' ? 'fault' : eqState === 'maint' ? 'maint' : '') +
             '" data-eq="' + Util.esc(eq.id) + '">' +
      '<div class="eq-head">' +
        '<span class="id">' + Util.esc(eq.id) + '</span>' +
        '<span class="badge ' + es.cls + '">' + es.label + '</span>' +
        '<span class="occ"><b>' + Util.num(used) + '</b>/' + Util.num(eq.capacity) + '</span>' +
        (fail ? '<span class="badge b-fault">失效 ' + fail + '</span>' : '') +
      '</div>' +
      gridHTML(station, eq, slotMap, opts) +
      '<div class="eq-foot">' +
        '<span>' + (cur ? '在测 ' + testing : (used ? '已装载' : '空载')) + '</span>' +
        '<span class="pbar"><i style="width:' + pct.toFixed(0) + '%"></i></span>' +
        '<span>' + (cur ? (remain > 0 ? '剩余 ' + Util.fmtDur(remain) : '已完成') : '—') + '</span>' +
      '</div>' +
    '</div>';
  }

  /* --------------------------------------------------------------------------
     服务器行（机柜布局用）
     -------------------------------------------------------------------------- */
  function serverRowHTML(station, eq, slotMap, opts) {
    let used = 0;
    for (let i = 0; i < eq.capacity; i++) {
      const rec = slotMap.get(eq.slotKeys[i]);
      if (rec && rec.state !== 'empty') used++;
    }
    const cls = used === eq.capacity ? 'full' : (used === 0 ? 'zero' : '');
    // 服务器号只显示序号部分，缩短行宽
    const short = eq.id.replace(/^SRV-[A-Z]-/, '');
    return '<div class="srv" data-eq="' + Util.esc(eq.id) + '">' +
      '<span class="sid" title="' + Util.esc(eq.id) + '">' + Util.esc(short) + '</span>' +
      gridHTML(station, eq, slotMap, opts) +
      '<span class="cnt ' + cls + '">' + used + '/' + eq.capacity + '</span>' +
    '</div>';
  }

  /* --------------------------------------------------------------------------
     机柜卡
     -------------------------------------------------------------------------- */
  function cabinetHTML(station, cab, slotMap, eqStates, opts) {
    let used = 0, cap = 0, fail = 0;
    cab.servers.forEach(eq => {
      const st = eqStates && eqStates[eq.id];
      cap += eq.capacity;
      for (let i = 0; i < eq.capacity; i++) {
        const rec = slotMap.get(eq.slotKeys[i]);
        if (!rec || rec.state === 'empty') continue;
        used++;
        if (rec.state === 'fail') fail++;
      }
    });
    const pct = cap ? used / cap * 100 : 0;
    const anyFault = cab.servers.some(eq => eqStates && eqStates[eq.id] === 'fault');

    return '<div class="cab' + (anyFault ? ' fault' : '') + '" data-cab="' + Util.esc(cab.id) + '">' +
      '<div class="cab-head">' +
        '<span>' + Util.esc(cab.id) + '</span>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<span class="oc">' + cab.servers.length + ' 台 · ' + used + '/' + cap +
          ' · <b style="color:' + (pct >= 95 ? '#6ee787' : 'var(--tx-2)') + '">' + pct.toFixed(0) + '%</b>' +
          (fail ? ' · <b style="color:#ff8b82">失效 ' + fail + '</b>' : '') +
        '</span>' +
      '</div>' +
      cab.servers.map(eq => serverRowHTML(station, eq, slotMap, opts)).join('') +
    '</div>';
  }

  /* --------------------------------------------------------------------------
     建立 key → 元素索引
       container 内 .cell 的文档序必须与 equipmentList × slotKeys 的发射序一致
     -------------------------------------------------------------------------- */
  function buildIndex(container, station, equipmentList) {
    const index = new Map();
    if (!container) return index;
    const cells = container.querySelectorAll('.cell[data-k]');
    let i = 0;
    for (let e = 0; e < equipmentList.length; e++) {
      const eq = equipmentList[e];
      for (let s = 0; s < eq.capacity; s++) {
        const node = cells[i++];
        if (!node) break;
        index.set(eq.slotKeys[s], node);
      }
    }
    return index;
  }

  /* --------------------------------------------------------------------------
     增量补丁：只改变化的格
       changes 为 Set<slotKey> 或 null（null = 全量重建标记）
     -------------------------------------------------------------------------- */
  function patch(index, changes, slotMap, pendingSet) {
    if (!index || !changes || !changes.size) return 0;
    let n = 0;
    changes.forEach(key => {
      const node = index.get(key);
      if (!node) return;
      const rec = slotMap.get(key);
      const state = (rec && rec.state) || 'empty';
      const stateCls = (SLOT_STATE[state] || SLOT_STATE.empty).cls;

      // 换状态类（保留 cell / no-sn / pending-bad 这些非状态类）
      const keep = (node.className || '').split(/\s+/).filter(c =>
        c && c.indexOf('s-') !== 0);
      const noSn = (!rec || !rec.sn);
      if (noSn && keep.indexOf('no-sn') < 0) keep.push('no-sn');
      const newCls = keep.filter(c => c !== 'no-sn').concat(noSn ? ['no-sn'] : []);
      newCls.push(stateCls);
      if (pendingSet && pendingSet.has(key)) newCls.push('pending-bad');
      node.className = newCls.join(' ');

      // 刷新 tooltip
      const parts = Schema.parseSlotKey(key);
      const eq = (Topology.all(LocalStore.load()).stationsMap[parts.station] || [])
        .filter(x => x.id === parts.equipmentId)[0];
      if (eq) node.title = cellTitle(parts.station, eq, parts.slotIndex, rec);

      // ICT 单格要更新可见的 SN 尾号
      if (ST[parts.station] && ST[parts.station].capacity === 1) {
        node.textContent = (rec && rec.sn) ? String(rec.sn).slice(-6) : '';
      }
      n++;
    });
    return n;
  }

  /* --------------------------------------------------------------------------
     Canvas 缩略图 —— 用于智慧看板的「全线热力图」与导出 PNG
       12,737 格用 canvas 画只要毫秒级，且不产生任何 DOM
     -------------------------------------------------------------------------- */
  const STATE_COLOR = {
    empty: '#232c38', testing: '#4f8ef7', pass: '#39d353',
    fail: '#f85149', abort: '#8b7fd4', maintenance: '#f0a500',
    damaged: '#b1583f', disabled: '#4a5568'
  };

  function drawCanvas(canvas, station, equipmentList, slotMap, opts) {
    const o = opts || {};
    const cell = o.cell || 3;
    const gap = o.gap == null ? 1 : o.gap;
    const cols = o.cols || 16;
    const total = equipmentList.reduce((a, e) => a + e.capacity, 0);
    const rows = Math.ceil(total / cols);
    const w = cols * (cell + gap);
    const h = rows * (cell + gap);
    const dpr = window.devicePixelRatio || 1;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    let i = 0;
    for (let e = 0; e < equipmentList.length; e++) {
      const eq = equipmentList[e];
      for (let s = 0; s < eq.capacity; s++) {
        const rec = slotMap.get(eq.slotKeys[s]);
        const state = (rec && rec.state) || 'empty';
        ctx.fillStyle = STATE_COLOR[state] || STATE_COLOR.empty;
        const x = (i % cols) * (cell + gap);
        const y = Math.floor(i / cols) * (cell + gap);
        ctx.fillRect(x, y, cell, cell);
        i++;
      }
    }
    return { width: w, height: h, total };
  }

  /* 汇总一组盘位的状态计数（避免视图层各写一遍） */
  function countStates(equipmentList, slotMap) {
    let cap = 0, used = 0, testing = 0, pass = 0, fail = 0, abort = 0, other = 0;
    equipmentList.forEach(eq => {
      for (let i = 0; i < eq.capacity; i++) {
        cap++;
        const rec = slotMap.get(eq.slotKeys[i]);
        if (!rec || rec.state === 'empty') continue;
        used++;
        if (rec.state === 'testing') testing++;
        else if (rec.state === 'pass') pass++;
        else if (rec.state === 'fail') fail++;
        else if (rec.state === 'abort') abort++;
        else other++;
      }
    });
    return { cap, used, free: cap - used, testing, pass, fail, abort, other,
             util: cap ? used / cap : 0 };
  }

  return {
    gridHTML, flatCardHTML, serverRowHTML, cabinetHTML,
    buildIndex, patch, drawCanvas, countStates, cellTitle, STATE_COLOR
  };
})();
