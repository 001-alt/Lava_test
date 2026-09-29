/* ============================================================================
   主题切换
   ----------------------------------------------------------------------------
   两套主题：
     dark  深色   工业现场弱光环境（默认）
     eye   护眼   暖色浅底，长时间盯屏降低眼疲劳
   另支持跟随系统（auto）—— 读 prefers-color-scheme，仅在系统偏好变化时切换。

   实现要点：
     · 主题通过 <html data-theme="..."> 驱动，CSS 只认这个属性
     · 写 localStorage 持久化；localStorage 不可用时退化为内存
     · 首次加载时在渲染前应用，避免「先亮后暗」的闪屏
   ============================================================================ */

const Theme = (() => {

  const KEY = 'ui.theme';
  const THEMES = [
    { key: 'dark', label: '深色', ico: '☾', desc: '默认，适合弱光环境' },
    { key: 'eye',  label: '护眼', ico: '☀', desc: '暖色浅底，降低眼疲劳' },
    { key: 'auto', label: '跟随系统', ico: '⌾', desc: '随操作系统的深浅色偏好切换' }
  ];

  let _cur = 'dark';           // 用户选择（可能是 auto）
  let _resolved = 'dark';      // 实际生效的主题

  function systemPrefers() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        return 'eye';
      }
    } catch (e) { }
    return 'dark';
  }

  function resolve(choice) {
    return choice === 'auto' ? systemPrefers() : (choice === 'eye' ? 'eye' : 'dark');
  }

  function apply(choice) {
    _cur = choice || 'dark';
    _resolved = resolve(_cur);
    const html = document.documentElement;
    html.setAttribute('data-theme', _resolved);
    // 让浏览器原生控件（滚动条、表单）也跟着变。
    // ⚠️ 只改 colorScheme 这一个属性 —— 早期版本在这里调用了
    //    html.removeAttribute('style')，那会把 <html> 上的**全部**内联样式清掉。
    html.style.colorScheme = _resolved === 'eye' ? 'light' : 'dark';
    syncButton();
    Bus.emit('theme:changed', { choice: _cur, resolved: _resolved });
    return _resolved;
  }

  function set(choice, silent) {
    try { LocalStore.ui.set('theme', choice); } catch (e) { }
    const r = apply(choice);
    if (!silent && typeof Toast !== 'undefined') {
      const t = THEMES.filter(x => x.key === choice)[0];
      Toast.ok('已切换到「' + (t ? t.label : choice) + '」' +
               (choice === 'auto' ? '（当前生效：' + (r === 'eye' ? '护眼' : '深色') + '）' : ''));
    }
    return r;
  }

  /* 循环切换 dark → eye → auto → dark */
  function cycle() {
    const i = THEMES.findIndex(t => t.key === _cur);
    const next = THEMES[(i + 1) % THEMES.length];
    return set(next.key);
  }

  /* 同步顶栏按钮文字 */
  function syncButton() {
    const btn = document.getElementById('btnTheme');
    if (!btn) return;
    const t = THEMES.filter(x => x.key === _cur)[0] || THEMES[0];
    btn.innerHTML = '<span class="ico"></span>' +
      '<span class="lbl">' + Util.esc(t.label) + '</span>';
    btn.title = '主题：' + t.label + '（' + t.desc + '）\n点击循环切换：深色 → 护眼 → 跟随系统';
  }

  /* 初始化：读偏好 → 应用 → 监听系统变化 */
  function init() {
    let choice = 'dark';
    try { choice = LocalStore.ui.get('theme', 'dark'); } catch (e) { }
    apply(choice);

    // auto 模式下跟随系统实时变化
    try {
      if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: light)');
        const onChange = () => { if (_cur === 'auto') apply('auto'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      }
    } catch (e) { }

    return _resolved;
  }

  return {
    THEMES, init, set, cycle, apply, syncButton,
    current: () => _cur,
    resolved: () => _resolved,
    isEye: () => _resolved === 'eye'
  };
})();
