/* ============================================================================
   右侧抽屉 —— 盘位详情 / 单块产品流转
   ============================================================================ */

const Drawer = (() => {
  let _cur = null;

  function open(opts) {
    const o = opts || {};
    const el = document.getElementById('drawer');
    const mask = document.getElementById('mask');
    if (!el) return null;

    el.innerHTML =
      '<div class="drawer-head">' +
        '<div>' +
          '<div class="t">' + Util.esc(o.title || '') + '</div>' +
          (o.sub ? '<div class="sub">' + Util.esc(o.sub) + '</div>' : '') +
        '</div>' +
        '<div class="spacer"></div>' +
        (o.actions || '') +
        '<button class="btn sm" data-dclose="1">关闭</button>' +
      '</div>' +
      '<div class="drawer-body">' + (o.body || '') + '</div>';

    el.classList.add('show');
    if (mask) mask.classList.add('show');
    document.body.classList.add('no-scroll');

    el.onclick = e => {
      if (e.target.closest('[data-dclose]')) close();
    };
    if (mask) mask.onclick = () => close();

    _cur = { el, opts: o };
    if (o.onMount) { try { o.onMount(el); } catch (e) { console.error('[Drawer] onMount：', e); } }
    return _cur;
  }

  function close() {
    const el = document.getElementById('drawer');
    const mask = document.getElementById('mask');
    if (el) { el.classList.remove('show'); el.onclick = null; }
    if (mask) { mask.classList.remove('show'); mask.onclick = null; }
    document.body.classList.remove('no-scroll');
    if (_cur && _cur.opts && _cur.opts.onClose) {
      try { _cur.opts.onClose(); } catch (e) { }
    }
    _cur = null;
  }

  function isOpen() {
    const el = document.getElementById('drawer');
    return !!(el && el.classList.contains('show'));
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen() && !Modal.isOpen()) close();
  });

  return { open, close, isOpen, current: () => _cur };
})();
