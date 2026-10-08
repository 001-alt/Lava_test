/* Desktop storage transport. The server injects runtime settings only for
   hosted SQLite mode. Standalone HTML retains its browser storage backend. */
const Sqlite = (() => {
  let _pending = Promise.resolve();
  let _writeError = null;
  function runtime() {
    return typeof window !== 'undefined' ? window.LAVA_RUNTIME : null;
  }
  function enabled() { return !!(runtime() && runtime().storage === 'sqlite'); }

  async function call(action, store, extra) {
    const r = runtime();
    if (!enabled()) throw new Error('SQLite 模式未启用');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const response = await fetch(r.url + '/api/storage', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'X-Lava-Storage-Token': r.token },
        body: JSON.stringify(Object.assign({ action, store }, extra || {}))
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || 'SQLite 操作失败');
      return body.result;
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '本地数据库响应超时，请重新启动桌面程序' : e.message);
    } finally { clearTimeout(timer); }
  }
  async function get(store, keys) {
    const out = [];
    for (let i = 0; i < keys.length; i += 5000) {
      out.push(...await call('get', store, { keys: keys.slice(i, i + 5000) }));
    }
    return out;
  }
  async function putMany(store, records) {
    let count = 0;
    for (let i = 0; i < records.length; i += 3000) {
      count += await call('putMany', store, { records: records.slice(i, i + 3000) });
    }
    return count;
  }
  async function keysAction(action, store, keys) {
    let out = action === 'ledgerFilter' ? [] : 0;
    for (let i = 0; i < keys.length; i += 5000) {
      const result = await call(action, store, { keys: keys.slice(i, i + 5000) });
      out = Array.isArray(out) ? out.concat(result) : out + result;
    }
    return out;
  }
  async function query(store, filter, opts) {
    const f = filter || {}, o = opts || {};
    // Function predicates stay in JavaScript. Apply limit after predicates.
    const predicate = f.where || o.filter;
    const serverOpts = Object.assign({}, o);
    if (predicate) delete serverOpts.limit;
    let rows = await call('query', store, { filter: f, opts: serverOpts });
    if (predicate) rows = rows.filter(predicate);
    return o.limit ? rows.slice(0, o.limit) : rows;
  }
  function saveConfig(config) {
    const snapshot = JSON.parse(JSON.stringify(config));
    _pending = _pending.catch(() => {}).then(() =>
      putMany('meta', [{ k: 'appConfig', v: snapshot, at: Date.now() }]));
    _pending.then(() => { _writeError = null; }, e => {
      _writeError = e;
      console.error('[SQLite] 配置保存失败：', e);
      if (typeof Toast !== 'undefined') Toast.error('配置未保存：' + e.message);
    });
    return { ok: true, pending: true };
  }
  async function flush() {
    await _pending;
    if (_writeError) throw _writeError;
  }
  return { enabled, runtime, call, get, putMany, keysAction, query, saveConfig, flush };
})();
