/* ============================================================================
   视口懒挂载 —— 机柜墙用
   ----------------------------------------------------------------------------
   FINAL 有 45 个机柜，每个机柜 9 行服务器 × 16 盘位 = 144 格。
   一次性挂载 45×144 = 6,480 格虽然可行，但滚动时会明显掉帧。
   这里用 IntersectionObserver 只挂载进入视口的机柜内容，同时挂载量控制在
   约 3,000 格以内。

   用法：
     VirtualList.observe(container, { onEnter(el), onLeave(el) })
   ============================================================================ */

const VirtualList = (() => {

  let _observer = null;
  const _handlers = new WeakMap();

  function supported() {
    return typeof IntersectionObserver !== 'undefined';
  }

  function ensureObserver() {
    if (_observer || !supported()) return _observer;
    _observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const h = _handlers.get(entry.target);
        if (!h) return;
        if (entry.isIntersecting) {
          if (!entry.target.dataset.vLoaded) {
            entry.target.dataset.vLoaded = '1';
            if (h.onEnter) { try { h.onEnter(entry.target); } catch (e) { console.error(e); } }
          }
        } else if (h.onLeave && entry.target.dataset.vLoaded) {
          try { h.onLeave(entry.target); } catch (e) { }
        }
      });
    }, {
      root: null,
      // 提前 400px 预挂载，滚动时不会看到空白
      rootMargin: '400px 0px',
      threshold: 0
    });
    return _observer;
  }

  /* 对容器内所有 [data-vitem] 元素启用懒挂载 */
  function observe(container, handlers) {
    if (!container) return;
    const items = container.querySelectorAll('[data-vitem]');
    if (!items.length) return;

    if (!supported()) {
      // 不支持时直接全部挂载，功能不受影响
      Array.prototype.forEach.call(items, el => {
        if (handlers.onEnter) handlers.onEnter(el);
      });
      return;
    }
    const obs = ensureObserver();
    Array.prototype.forEach.call(items, el => {
      // 已挂载的直接调一次，避免首屏空着
      _handlers.set(el, handlers);
      const rect = el.getBoundingClientRect();
      if (rect.top < (window.innerHeight + 400) && rect.bottom > -400) {
        el.dataset.vLoaded = '1';
        if (handlers.onEnter) handlers.onEnter(el);
      }
      obs.observe(el);
    });
  }

  function unobserveAll(container) {
    if (!container || !_observer) return;
    const items = container.querySelectorAll('[data-vitem]');
    Array.prototype.forEach.call(items, el => {
      try { _observer.unobserve(el); } catch (e) { }
      _handlers.delete(el);
    });
  }

  /* 分批执行（首屏渲染大块数据时避免长时间阻塞主线程） */
  function chunked(items, fn, chunkSize) {
    const CH = chunkSize || 200;
    const list = items.slice();
    return new Promise(resolve => {
      let i = 0;
      function step() {
        const end = Math.min(i + CH, list.length);
        for (; i < end; i++) fn(list[i], i);
        if (i < list.length) {
          if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(step);
          else setTimeout(step, 0);
        } else resolve();
      }
      step();
    });
  }

  return { observe, unobserveAll, chunked, supported };
})();
