/* ============================================================================
   桥接客户端 —— 页面与 Python 桥接服务之间的唯一通道
   ----------------------------------------------------------------------------
   浏览器不能直连 FTP、不能遍历本机任意目录、不能 SSH 到机台，
   这些都必须经桥接转发。

   统一在这里做三件事：
     · URL 拼接与令牌注入
     · 错误归一（网络不可达 / HTTP 错误 / 桥接未配置，三者要分得清）
     · 超时控制（现场网络慢，不能让请求无限挂着）
   ============================================================================ */

const Bridge = (() => {

  const DEFAULT_TIMEOUT = 20000;

  /* 桥接地址：可在「系统设置」里改；空串表示未配置，所有调用据此短路 */
  function base() {
    const u = (App.cfg.channels.ftp || {}).bridgeUrl || '';
    return String(u).trim().replace(/\/+$/, '');
  }
  function configured() { return !!base(); }

  function token() {
    return (App.cfg.channels.ftp || {}).token
        || (App.cfg.settings || {}).bridgeToken || '';
  }

  function qs(params) {
    if (!params) return '';
    const parts = [];
    Object.keys(params).forEach(k => {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  /* 统一的错误类型，便于上层区分对待 */
  class BridgeError extends Error {
    constructor(msg, kind, status) {
      super(msg);
      this.kind = kind;        // unconfigured | unreachable | http | timeout | parse
      this.status = status || 0;
    }
  }

  async function request(path, opts) {
    const o = opts || {};
    const b = base();
    if (!b) throw new BridgeError('未配置桥接服务地址', 'unconfigured');

    const url = b + path + qs(o.params);
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), o.timeout || DEFAULT_TIMEOUT) : null;

    const headers = Object.assign({}, o.headers || {});
    const tk = token();
    if (tk) headers['X-Bridge-Token'] = tk;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, {
        method: o.method || 'GET',
        headers,
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: ctl ? ctl.signal : undefined
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e.name === 'AbortError') {
        throw new BridgeError('桥接响应超时（' + ((o.timeout || DEFAULT_TIMEOUT) / 1000) + ' 秒）', 'timeout');
      }
      throw new BridgeError('桥接服务不可达：请确认已运行「启动桥接服务.bat」', 'unreachable');
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (e) { }
      throw new BridgeError(msg, 'http', res.status);
    }
    return res;
  }

  async function api(path, params, opts) {
    const res = await request(path, Object.assign({ params }, opts || {}));
    try { return await res.json(); }
    catch (e) { throw new BridgeError('桥接返回的不是 JSON', 'parse'); }
  }

  function post(path, body, opts) {
    return api(path, null, Object.assign({ method: 'POST', body: body || {} }, opts || {}));
  }

  /* 取二进制（日志文件下载）。文件名与时间从响应头读，比再发一次请求省事 */
  async function fetchBin(path, params, opts) {
    const res = await request(path, Object.assign({ params }, opts || {}));
    const ab = await res.arrayBuffer();
    const raw = res.headers.get('X-File-Name') || '';
    let name = '';
    try { name = raw ? decodeURIComponent(raw) : ''; } catch (e) { name = raw; }
    const mtime = Number(res.headers.get('X-File-Mtime') || 0) * 1000;
    return { buffer: ab, name: name || (params && params.path ? Util.basename(params.path) : 'download.bin'),
             mtime: mtime || null };
  }

  /* 文本响应（SSH cat / slt） */
  async function fetchText(path, params, opts) {
    const res = await request(path, Object.assign({ params }, opts || {}));
    return res.text();
  }

  /* --------------------------------------------------------------------------
     健康检查
     -------------------------------------------------------------------------- */
  let _health = null;
  let _healthAt = 0;
  let _healthKey = '';
  let _healthFlight = null;

  function healthKey() { return base() + '\n' + token(); }

  // 同步快照供界面先画出来；地址或令牌改变后不沿用旧连接状态。
  function peekHealth() {
    if (_health && _healthKey === healthKey()) return _health;
    return { ok: false, configured: configured(), pending: configured(),
             error: configured() ? '' : '未配置桥接地址' };
  }

  function health(force) {
    const key = healthKey();
    if (_healthFlight && _healthFlight.key === key) return _healthFlight.promise;
    if (!force && _health && _healthKey === key && Date.now() - _healthAt < 15000) {
      return Promise.resolve(_health);
    }
    if (!configured()) {
      _health = { ok: false, configured: false, error: '未配置桥接地址' };
      _healthKey = key;
      _healthAt = Date.now();
      return Promise.resolve(_health);
    }
    const flight = { key, promise: null };
    flight.promise = (async () => {
      let timer, result;
      try {
        // 同时限制 JSON 响应体的等待；网络检查永远不能拖住本地界面。
        const deadline = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new BridgeError('桥接连接检测超时', 'timeout')), 1500);
        });
        const h = await Promise.race([api('/api/health', null, { timeout: 1500 }), deadline]);
        result = Object.assign({ configured: true }, h);
      } catch (e) {
        result = { ok: false, configured: true, error: e.message, kind: e.kind };
      } finally {
        clearTimeout(timer);
      }
      if (key === healthKey()) {
        _health = result;
        _healthKey = key;
        _healthAt = Date.now();
      }
      if (_healthFlight === flight) _healthFlight = null;
      return result;
    })();
    _healthFlight = flight;
    return flight.promise;
  }

  /* 返回人能看的一句话状态，供顶栏胶囊显示 */
  function healthLabel(h) {
    if (!h) return '桥接：未知';
    if (!h.configured) return '桥接未配置';
    if (h.pending) return '桥接：检测中';
    if (!h.ok) return h.kind === 'unreachable' ? '离线模式（桥接未启动）' : '离线模式（桥接不可用）';
    const parts = [];
    parts.push('v' + (h.version || '?'));
    if (h.ftpConfigured) parts.push(h.ftpConnected ? 'FTP正常' : 'FTP异常');
    if (h.sshHosts) parts.push('机台' + h.sshHosts);
    return '桥接：' + parts.join(' · ');
  }

  function healthChipClass(h) {
    if (!h || !h.configured) return 'chip';
    if (!h.ok) return 'chip warn';
    if (h.ftpConfigured && !h.ftpConnected) return 'chip warn';
    return 'chip ok';
  }

  /* 把当前配置推给桥接（含 FTP/SSH 账号与机台清单） */
  async function pushConfig() {
    const ch = App.cfg.channels;
    return post('/api/config', {
      ftp: ch.ftp || {},
      local: { roots: [(ch.localDir || {}).path].filter(Boolean) },
      mes: ch.webapp || {},
      ssh: Object.assign({}, ch.ssh || {}, {
        password: (App.cfg.pullSettings && App.cfg.pullSettings.sshPassword) || '',
        logRoot: (ch.ssh && ch.ssh.logRoot) || '/home/dml_slt_test/dml_slt_test_logs'
      }),
      webRoot: ''
    });
  }

  /* 把设备台账里的机台 IP 下发给桥接，供巡检用 */
  async function pushHosts() {
    const list = Registry.toBridgeList(App.devices);
    if (!list.length) return { ok: true, count: 0 };
    return post('/api/ssh/hosts', { hosts: list });
  }

  return {
    base, configured, token, qs,
    request, api, post, fetchBin, fetchText,
    health, peekHealth, healthLabel, healthChipClass,
    pushConfig, pushHosts,
    BridgeError
  };
})();
