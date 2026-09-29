/* ============================================================================
   时间线 —— 单块产品的工序流转链
   ============================================================================ */

const Timeline = (() => {

  /* 工序流转链（追溯抽屉用）
     chain 来自 Trace.bySn()：{ station, state, last, records, retest, detail, bypass } */
  function flow(chain, opts) {
    const o = opts || {};
    const clsMap = { pass: 'd-pass', fail: 'd-fail', abort: 'd-abort',
                     testing: 'd-run', pending: 'd-skip', unknown: 'd-skip' };
    const pillMap = {
      pass: '<span class="pill p-pass">通过</span>',
      fail: '<span class="pill p-fail">失败</span>',
      abort: '<span class="pill p-abort">异常终止</span>',
      pending: '<span class="pill p-wait">未开始</span>',
      unknown: '<span class="pill p-wait">未知</span>'
    };

    return '<div class="flow">' + (chain || []).map((seg, i) => {
      const st = ST[seg.station];
      const s = st || { name: seg.station, cn: '', capacity: '-', unit: '', cycleMin: 0, loads: '' };
      const d = clsMap[seg.state] || 'd-skip';
      const isCur = seg.state === 'testing' || (o.currentStation === seg.station && seg.state === 'pending' && !seg.bypass);

      let meta = '';
      const last = seg.last;
      if (last) {
        meta = Util.fmtFull(last.time);
        if (o.showDevice !== false && last.equipmentId) {
          meta += ' · ' + Util.esc(last.equipmentId);
          if (last.slotIndex != null) meta += ' 位' + (last.slotIndex + 1);
        }
        if (last.errCode) meta += ' · <span style="color:#ff8b82">' + Util.esc(last.errCode) + '</span>';
      }

      return '<div class="fstep ' + d + (isCur ? ' cur' : '') + (seg.bypass ? ' bypass' : '') + '">' +
        '<i class="fdot"></i>' +
        '<div class="fn">' +
          '<span class="nm">' + (i + 1) + '. ' + Util.esc(s.name) + '</span>' +
          (pillMap[seg.state] || pillMap.unknown) +
          '<span style="font-size:11px;color:var(--tx-3)">' + Util.esc(s.cn || '') + '</span>' +
        '</div>' +
        '<div class="fm">' + s.capacity + ' 盘位/' + Util.esc(s.unit || '台') +
          ' · 单轮 ' + Util.fmtCycle(s.cycleMin) + '</div>' +
        (meta ? '<div class="fmeta">' + meta + '</div>' : '') +
        (seg.retest ? '<div class="fmeta" style="color:#f5cd6b">复测 ' + seg.retest + ' 次</div>' : '') +
        (seg.detail && !seg.retest ? '<div class="fmeta">' + Util.esc(seg.detail) + '</div>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  /* 通用时间线（追溯查询页用）
     items: [{ kind, time, station, sn, result, text }] */
  function events(items, opts) {
    const o = opts || {};
    const list = (items || []).slice(0, o.limit || 60);
    if (!list.length) return '<div class="empty-tip">无时间线记录</div>';
    return '<div class="trace-timeline">' + list.map(it => {
      const cls = it.kind === 'bad' ? 't-fail' : it.kind === 'error' ? 't-error'
                : (String(it.result || '').toUpperCase() === 'PASS' ? 't-pass' : 't-fail');
      return '<div class="tl-item ' + cls + '">' +
        '<div class="tl-head">' +
          '<span class="tl-time">' + Util.fmtTime(it.time) + '</span>' +
          '<span class="pill ' + L.resultPill(it.result) + '">' +
            Util.esc(it.station || '') + '</span>' +
          (it.sn ? '<span class="col-sn mono" style="font-size:11px;color:var(--tx-2)">' +
            Util.esc(it.sn) + '</span>' : '') +
        '</div>' +
        '<div class="tl-body">' + Util.esc(it.text || '') + '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  return { flow, events };
})();
