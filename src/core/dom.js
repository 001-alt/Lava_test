/* ============================================================================
   DOM 工具 —— 选择、创建、增量补丁、事件委托
   ----------------------------------------------------------------------------
   本项目盘位节点上万，绝不给每个节点单独绑事件监听，一律用委托。
   ============================================================================ */

const Dom = (() => {

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function byId(id) { return document.getElementById(id); }

  /* 创建元素：el('div', {class:'x', 'data-k':1}, [child, '文本']) */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class' || k === 'className') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else node.setAttribute(k, v);
      }
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c == null || c === false) return;
        node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
      });
    }
    return node;
  }

  /* 设置 innerHTML（统一入口，便于将来加净化） */
  function html(node, markup) {
    if (typeof node === 'string') node = byId(node);
    if (node) node.innerHTML = markup;
    return node;
  }
  function text(node, t) {
    if (typeof node === 'string') node = byId(node);
    if (node) node.textContent = t;
    return node;
  }
  function show(node, on) {
    if (typeof node === 'string') node = byId(node);
    if (node) node.classList.toggle('hide', !on);
  }
  function setClass(node, cls, on) {
    if (node) node.classList.toggle(cls, !!on);
  }
  function toggle(node, force) {
    if (typeof node === 'string') node = byId(node);
    if (!node) return false;
    const on = (force === undefined) ? !node.classList.contains('on') : !!force;
    node.classList.toggle('on', on);
    return on;
  }

  /* ---------- 事件委托 ----------
     在容器上绑一次，通过 closest(selector) 命中目标。
     返回取消函数。 */
  function delegate(root, evtName, selector, fn) {
    const r = (typeof root === 'string') ? byId(root) : root;
    if (!r) return () => {};
    const handler = function (e) {
      const t = e.target.closest ? e.target.closest(selector) : null;
      if (t && r.contains(t)) fn.call(t, e, t);
    };
    r.addEventListener(evtName, handler);
    return () => r.removeEventListener(evtName, handler);
  }

  /* ---------- 增量补丁 ----------
     渲染器维护 key → element 映射，状态变化时只改 class/title，
     不重建子树。这是上万盘位下不卡的关键。 */
  function patchClass(node, clsList, newCls) {
    if (!node) return;
    // 只移除本项目的状态类前缀，不动其它类
    const keep = (node.className || '').split(/\s+/)
      .filter(c => c && !/^s-|^b-|^st-/.test(c));
    node.className = keep.concat(newCls ? [newCls] : []).join(' ');
  }

  /* ---------- 空态 ---------- */
  function empty(container, text, colspan) {
    const c = (typeof container === 'string') ? byId(container) : container;
    if (!c) return;
    c.innerHTML = '<div class="empty-tip">' + Util.esc(text || '暂无数据') + '</div>';
  }

  /* ---------- 滚动定位 + 高亮（对应 RDIMM 的 jumpToLayer） ---------- */
  function scrollTo(node, ms) {
    if (!node) return;
    try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { }
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), ms || 2400);
  }

  /* 让视口滚到某个元素（含固定顶栏偏移修正） */
  function scrollIntoViewSticky(node, offset) {
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const top = window.pageYOffset + rect.top - (offset || 110);
    window.scrollTo({ top, behavior: 'smooth' });
  }

  return {
    $, $$, byId, el, html, text, show, setClass, toggle,
    delegate, patchClass, empty, scrollTo, scrollIntoViewSticky
  };
})();
