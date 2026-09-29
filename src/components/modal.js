/* ============================================================================
   模态框 —— 通用容器 + 确认框
   ----------------------------------------------------------------------------
   内容用 innerHTML 生成，事件用委托绑定（delegate），避免每个模态框重复写绑定。
   ============================================================================ */

const Modal = (() => {

  const stack = [];             // 支持嵌套（确认框叠在模态框上）

  const SIZES = { normal: '', wide: 'wide', wider: 'wider', full: 'full' };

  /* --------------------------------------------------------------------------
     打开
       opts: { id, title, sub, size, body, footer, onMount, onClose, onEscape }
       body/footer 可以是 HTML 字符串
       返回 handle { el, close(), body, setBody(), footer }
     -------------------------------------------------------------------------- */
  function open(opts) {
    const o = opts || {};
    const root = document.getElementById('modalRoot');
    if (!root) { console.error('[Modal] 缺少 #modalRoot 挂载点'); return null; }

    // 同 id 的已存在则先关掉，避免重复
    if (o.id) closeById(o.id);

    const overlay = Dom.el('div', { class: 'modal-overlay', 'data-modal': o.id || '' });
    overlay.innerHTML =
      '<div class="modal ' + (SIZES[o.size] || '') + '">' +
        '<div class="modal-head">' +
          '<div>' +
            '<div class="t">' + Util.esc(o.title || '') + '</div>' +
            (o.sub ? '<div class="sub">' + Util.esc(o.sub) + '</div>' : '') +
          '</div>' +
          '<div class="spacer"></div>' +
          '<button class="modal-close" data-mclose="1" title="关闭（Esc）">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' + (o.body || '') + '</div>' +
        (o.footer !== false
          ? '<div class="modal-foot">' + (o.footer || '<button class="btn" data-mclose="1">关闭</button>') + '</div>'
          : '') +
      '</div>';

    root.appendChild(overlay);

    const handle = {
      id: o.id || '',
      el: overlay,
      body: overlay.querySelector('.modal-body'),
      card: overlay.querySelector('.modal'),
      close: () => close(handle),
      setBody(html) { handle.body.innerHTML = html; },
      setFooter(html) {
        const f = overlay.querySelector('.modal-foot');
        if (f) f.innerHTML = html;
      },
      query: sel => overlay.querySelector(sel),
      queryAll: sel => Array.prototype.slice.call(overlay.querySelectorAll(sel))
    };

    /* 关闭：点 X、点底部按钮、点遮罩空白处 */
    overlay.addEventListener('click', e => {
      if (e.target === overlay && o.maskClose !== false) { close(handle); return; }
      if (e.target.closest('[data-mclose]')) close(handle);
    });

    // Esc 关闭最上层
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(handle); }
    });

    stack.push(handle);
    if (o.onMount) {
      try { o.onMount(handle); }
      catch (e) { console.error('[Modal] onMount 出错：', e); }
    }
    // 聚焦第一个输入框，便于键盘操作
    setTimeout(() => {
      const first = overlay.querySelector('input:not([type=hidden]),select,textarea');
      if (first) { try { first.focus(); } catch (e) { } }
    }, 40);

    return handle;
  }

  function close(handle) {
    if (!handle || !handle.el) return;
    const i = stack.indexOf(handle);
    if (i >= 0) stack.splice(i, 1);
    try { handle.el.remove(); } catch (e) { }
    if (handle.onClose) { try { handle.onClose(); } catch (e) { } }
  }

  function closeById(id) {
    stack.slice().forEach(h => { if (h.id === id) close(h); });
  }
  function closeTop() {
    if (stack.length) { close(stack[stack.length - 1]); return true; }
    return false;
  }
  function closeAll() {
    stack.slice().forEach(close);
  }
  function isOpen() { return stack.length > 0; }

  /* --------------------------------------------------------------------------
     确认框 —— 返回 Promise<boolean>
     -------------------------------------------------------------------------- */
  function confirm(opts) {
    const o = (typeof opts === 'string') ? { text: opts } : (opts || {});
    return new Promise(resolve => {
      const root = document.getElementById('modalRoot');
      const overlay = Dom.el('div', { class: 'modal-overlay' });
      overlay.innerHTML =
        '<div class="confirm-box">' +
          '<div class="ct">' + Util.esc(o.title || '确认操作') + '</div>' +
          '<div class="cb">' + (o.html || Util.esc(o.text || '')) + '</div>' +
          '<div class="cf">' +
            '<button class="btn" data-cf="0">' + Util.esc(o.cancelText || '取消') + '</button>' +
            '<button class="btn ' + (o.danger ? 'danger' : 'primary') + '" data-cf="1">' +
              Util.esc(o.okText || '确定') + '</button>' +
          '</div>' +
        '</div>';
      let settled = false;
      const finish = v => {
        if (settled) return;
        settled = true;
        overlay.remove();
        resolve(v);
      };
      overlay.addEventListener('click', e => {
        if (e.target === overlay) return finish(false);
        const b = e.target.closest('[data-cf]');
        if (b) finish(b.dataset.cf === '1');
      });
      root.appendChild(overlay);
      setTimeout(() => {
        const okBtn = overlay.querySelector('[data-cf="1"]');
        if (okBtn) { try { okBtn.focus(); } catch (e) { } }
      }, 40);
    });
  }

  /* 输入框弹窗（替代 RDIMM 大量使用的 prompt） */
  function prompt(opts) {
    const o = (typeof opts === 'string') ? { text: opts } : (opts || {});
    return new Promise(resolve => {
      const h = open({
        title: o.title || '请输入',
        size: 'normal',
        body: '<div class="form-group">' +
                '<label class="form-label">' + Util.esc(o.text || '') + '</label>' +
                '<input class="form-input" id="__promptInput" value="' + Util.esc(o.value || '') + '">' +
                (o.hint ? '<div class="form-hint">' + Util.esc(o.hint) + '</div>' : '') +
              '</div>',
        footer: '<button class="btn" data-cf="0">取消</button>' +
                '<button class="btn primary" data-cf="1">确定</button>',
        onMount(hh) {
          const input = hh.query('#__promptInput');
          const done = v => { h.close(); resolve(v); };
          hh.el.addEventListener('click', e => {
            const b = e.target.closest('[data-cf]');
            if (b) done(b.dataset.cf === '1' ? input.value : null);
          });
          input.addEventListener('keydown', e => {
            if (e.key === 'Enter') done(input.value);
          });
        },
        onClose() { resolve(null); }
      });
    });
  }

  /* Esc 兜底：模态框自己也会处理，这里管没有焦点在模态内的情况 */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && stack.length) {
      const top = stack[stack.length - 1];
      // 若焦点在输入框且按 Esc，仍关闭（用户预期）
      if (!e.target.closest || !e.target.closest('.modal-overlay')) close(top);
    }
  });

  return { open, close, closeById, closeTop, closeAll, isOpen, confirm, prompt, stack };
})();
