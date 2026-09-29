/* ============================================================================
   提示条
   ============================================================================ */

const Toast = (() => {

  function show(msg, type, title, ms) {
    const root = document.getElementById('toastRoot');
    if (!root) { console.log('[Toast:' + (type || 'info') + ']', msg); return; }
    const node = document.createElement('div');
    node.className = 'toast ' + (type || '');
    node.innerHTML = (title ? '<div class="toast-title">' + Util.esc(title) + '</div>' : '') +
                     '<div class="toast-sub">' + Util.esc(msg) + '</div>';
    root.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .25s, transform .25s';
      node.style.opacity = '0';
      node.style.transform = 'translateX(20px)';
      setTimeout(() => node.remove(), 260);
    }, ms || 3000);
  }

  function ok(msg, title)   { show(msg, 'ok', title); }
  function warn(msg, title) { show(msg, 'warn', title, 4200); }
  function error(msg, title){ show(msg, 'err', title, 6000); }
  function info(msg, title) { show(msg, 'info', title); }

  return { show, ok, warn, error, info };
})();

/* 数据层在降级/配额异常时会调 Toast —— 通过事件解耦，避免 store 依赖 UI 模块 */
if (typeof Bus !== 'undefined') {
  Bus.on(EVT.TOAST, p => {
    if (!p) return;
    Toast.show(p.msg, p.type, p.title);
  });
}
