/* ============================================================================
   配置层存储 —— localStorage
   ----------------------------------------------------------------------------
   只放「小、启动即需、同步可读」的东西：系统设置、规则表、UI 偏好。
   大数据（盘位、记录）走 IndexedDB，见 store/idb.js。

   RDIMM 的教训：它把全量 state 塞进 localStorage 且无配额兜底，
   存在 setItem 抛 QuotaExceededError 导致保存静默失败的风险。
   这里必须显式处理配额异常并把失败暴露给用户。
   ============================================================================ */

const LocalStore = (() => {

  let _cache = null;            // 内存副本，避免频繁 JSON.parse
  let _dirty = false;
  let _quotaWarned = false;
  let _initPromise = null;

  function init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      if (Sqlite.enabled()) {
        const rows = await Sqlite.get('meta', ['appConfig']);
        _cache = mergeDeep(Schema.defaultConfig(), rows.length ? rows[0].v : {});
      }
      return load();
    })();
    return _initPromise;
  }

  /* ---------- 可用性探测 ---------- */
  function available() {
    try {
      const k = '__lava_test_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- 读 ---------- */
  function load(force) {
    if (_cache && !force) return _cache;
    const def = Schema.defaultConfig();
    if (!available()) {
      console.warn('[LocalStore] localStorage 不可用，配置仅存于内存（刷新即失）');
      _cache = def;
      return _cache;
    }
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) {
        _cache = def;
        save();
        return _cache;
      }
      const saved = JSON.parse(raw);
      // 逐层合并默认值：新增的配置项对老存档自动补齐
      _cache = mergeDeep(def, saved);
      return _cache;
    } catch (e) {
      console.error('[LocalStore] 配置解析失败，回退默认值：', e);
      _cache = def;
      return _cache;
    }
  }

  /* 深合并：默认值为底，存档值覆盖；数组直接取存档值 */
  function mergeDeep(base, over) {
    if (over === undefined) return base;
    if (Array.isArray(base) || Array.isArray(over)) return Util.clone(over);
    if (base && typeof base === 'object' && over && typeof over === 'object') {
      const out = {};
      const keys = new Set(Object.keys(base).concat(Object.keys(over)));
      keys.forEach(k => {
        out[k] = (k in over) ? mergeDeep(base[k], over[k]) : Util.clone(base[k]);
      });
      return out;
    }
    return over;
  }

  /* ---------- 写 ---------- */
  function save() {
    if (!_cache) return { ok: false, reason: 'empty' };
    if (Sqlite.enabled()) {
      _dirty = false;
      return Sqlite.saveConfig(_cache);
    }
    if (!available()) return { ok: false, reason: 'unavailable' };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(_cache));
      _quotaWarned = false;
      _dirty = false;
      return { ok: true };
    } catch (e) {
      const isQuota = e && (e.name === 'QuotaExceededError' ||
                            e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                            e.code === 22);
      if (isQuota) {
        // 明确告知，不静默失败
        if (!_quotaWarned) {
          _quotaWarned = true;
          console.error('[LocalStore] 配置写入超出浏览器配额');
          if (typeof Toast !== 'undefined') {
            Toast.error('浏览器存储空间不足，配置未能保存。请到「导出中心」备份后清理旧数据。');
          }
        }
        return { ok: false, reason: 'quota' };
      }
      console.error('[LocalStore] 配置写入失败：', e);
      return { ok: false, reason: 'error', error: e };
    }
  }

  /* 延迟写：高频改 UI 偏好时用（如切换视图），避免每次 setItem */
  const saveSoon = Util.debounce(save, 400);

  function set(path, value) {
    const c = load();
    const parts = String(path).split('.');
    let node = c;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    _dirty = true;
    return save();
  }

  function get(path, fallback) {
    const c = load();
    const parts = String(path).split('.');
    let node = c;
    for (let i = 0; i < parts.length; i++) {
      if (node == null) return fallback;
      node = node[parts[i]];
    }
    return node === undefined ? fallback : node;
  }

  /* ---------- UI 偏好快捷读写（高频，走延迟写） ---------- */
  const ui = {
    get(k, d) { return get('ui.' + k, d); },
    set(k, v) {
      const c = load();
      c.ui[k] = v;
      _dirty = true;
      saveSoon();
      return v;
    }
  };

  /* ---------- 整体替换（导入配置时用） ---------- */
  function replace(cfg) {
    _cache = mergeDeep(Schema.defaultConfig(), cfg || {});
    return save();
  }

  function reset() {
    _cache = Schema.defaultConfig();
    return save();
  }

  /* 估算当前占用（字节） */
  function size() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? raw.length * 2 : 0;   // UTF-16
    } catch (e) { return 0; }
  }

  function isDirty() { return _dirty; }

  async function flush() {
    if (_dirty) save();
    if (Sqlite.enabled()) await Sqlite.flush();
  }

  return { init, available, load, save, saveSoon, set, get, ui, replace, reset, size, isDirty, flush };
})();
