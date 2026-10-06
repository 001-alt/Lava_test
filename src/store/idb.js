/* ============================================================================
   数据层存储 —— IndexedDB
   ----------------------------------------------------------------------------
   ⚠️ 关键风险：Chrome / Edge 在 file:// 协议下会禁用 IndexedDB（不透明来源）。
      因此本模块必须能优雅降级，Repository 会探测可用性后选择后端。
      → 生产环境推荐由桥接服务托管页面（http://127.0.0.1:8770/），
        127.0.0.1 属安全上下文，IndexedDB / FileSystemAccess / CompressionStream 全部可用。

   全部方法返回 Promise；调用方一律 await，不感知底层是 IDB 还是降级后端。
   ============================================================================ */

const Idb = (() => {

  let _db = null;
  let _openPromise = null;
  let _available = null;          // null=未探测, true/false=结果

  /* 对象仓定义：名字 → { keyPath, indexes:[[名称, 字段, {unique}]] } */
  const STORES = {
    slots:      { keyPath: 'key',    indexes: [['station', 'station'], ['state', 'state'], ['sn', 'sn'], ['woNo', 'woNo']] },
    records:    { keyPath: 'dedupKey', indexes: [['day', 'day'], ['sn', 'sn'], ['station', 'station'], ['result', 'result']] },
    bad:        { keyPath: 'id',     indexes: [['day', 'day'], ['station', 'station'], ['sn', 'sn'], ['confirmed', 'confirmed'], ['verdict', 'verdict']] },
    error:      { keyPath: 'id',     indexes: [['day', 'day'], ['station', 'station'], ['errCode', 'errCode'], ['handled', 'handled'], ['dedupKey', 'dedupKey']] },
    judgements: { keyPath: 'id',     indexes: [['at', 'at'], ['sn', 'sn'], ['station', 'station']] },
    archives:   { keyPath: 'id',     indexes: [['woId', 'woId'], ['station', 'station'], ['releasedAt', 'releasedAt']] },
    workorders: { keyPath: 'id',     indexes: [['no', 'no'], ['status', 'status'], ['createdAt', 'createdAt']] },
    /* 设备台账：真实设备的身份与位置（机柜/位号/IP/型号）。
       与 slots 不同 —— slots 是「当前测试状态」，devices 是「设备本身」。 */
    devices:    { keyPath: 'id',     indexes: [['station', 'station'], ['cabinet', 'cabinet'], ['ip', 'ip']] },
    logindex:   { keyPath: 'id',     indexes: [['path', 'path'], ['station', 'station'], ['pulledAt', 'pulledAt']] },
    /* 幂等台账：唯一索引拦截重复入库，这是「同一日志拉两次不重复计数」的保证 */
    ledger:     { keyPath: 'dedupKey', indexes: [['at', 'at']] },
    /* 原始日志留档：格式明确后可离线重解析，不必重新拉取 */
    rawfiles:   { keyPath: 'path',   indexes: [['pulledAt', 'pulledAt'], ['station', 'station']] },
    meta:       { keyPath: 'k',      indexes: [] }
  };

  /* ---------- 可用性探测 ---------- */
  function available() {
    if (_available !== null) return Promise.resolve(_available);
    return new Promise(resolve => {
      let done = false;
      let timer;
      const finish = ok => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        _available = ok;
        resolve(ok);
      };
      try {
        if (typeof indexedDB === 'undefined' || !indexedDB) return finish(false);
        const req = indexedDB.open('__lava_probe__', 1);
        req.onerror = () => finish(false);
        req.onblocked = () => finish(false);
        req.onsuccess = () => {
          try { req.result.close(); indexedDB.deleteDatabase('__lava_probe__'); } catch (e) { }
          finish(true);
        };
        // file:// 下 Chrome 可能既不报错也不回调，加超时兜底
        timer = setTimeout(() => finish(false), 1000);
      } catch (e) {
        finish(false);
      }
    });
  }

  /* 删库重建 —— 最后手段。
     结构不对时数据本来也读不出来，但**会丢数据**，所以必须明确告知用户，
     并且限制重建次数，避免「重建后仍不对」导致无限循环。 */
  let _recreateCount = 0;
  function _recreate(resolve, reject, missing) {
    if (_recreateCount >= 2) {
      reject(new Error('数据库结构无法修复（仍缺 ' + missing.join(', ') + '）'));
      return;
    }
    _recreateCount++;
    console.error('[Idb] 数据库结构异常，重建中。缺失：' + missing.join(', ') +
                  '。原有数据将丢失。');
    if (typeof Toast !== 'undefined') {
      Toast.warn('本地数据库结构需要重建（原有测试数据会清空）。' +
                 '如有正式数据请先导出备份。', '数据库升级');
    }
    try { if (_db) _db.close(); } catch (e) { }
    _db = null;
    _openPromise = null;

    const del = indexedDB.deleteDatabase(IDB_NAME);
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      open().then(resolve, reject);
    };
    del.onsuccess = go;
    del.onerror = go;
    // 别的标签页还占着这个库时会被 block —— 必须给用户可操作的提示
    del.onblocked = () => {
      if (done) return;
      done = true;
      reject(new Error('数据库被其它标签页占用，无法重建。' +
                       '请关闭本页面的其它标签页后刷新。'));
    };
  }

  /* ---------- 打开 ---------- */
  function open() {
    if (_db) return Promise.resolve(_db);
    if (_openPromise) return _openPromise;

    _openPromise = new Promise((resolve, reject) => {
      let settled = false;
      try {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);

        req.onupgradeneeded = ev => {
          const db = req.result;
          const from = ev.oldVersion || 0;
          Object.keys(STORES).forEach(name => {
            const def = STORES[name];
            let store;
            if (!db.objectStoreNames.contains(name)) {
              store = db.createObjectStore(name, { keyPath: def.keyPath });
            } else {
              store = req.transaction.objectStore(name);
            }
            (def.indexes || []).forEach(ix => {
              const [ixName, keyPath, opts] = ix;
              if (!store.indexNames.contains(ixName)) {
                store.createIndex(ixName, keyPath, opts || {});
              }
            });
          });
          // 版本迁移钩子（各版本增量升级）
          if (typeof Migrate !== 'undefined' && Migrate.onUpgrade) {
            try { Migrate.onUpgrade(db, from, IDB_VERSION); }
            catch (e) { console.error('[Idb] 迁移失败：', e); }
          }
        };

        req.onsuccess = () => {
          const db = req.result;
          // 超时后 Repo 已选择降级后端，迟到的连接不能重新接管存储。
          if (settled) { db.close(); return; }

          /* 结构自愈：打开后核对所有声明的对象仓是否都在。
             版本号忘了升、或别的标签页把库改成了旧结构时，
             这里会发现问题。处理方式分两步：
               ① 先尝试「升一版再开」—— onupgradeneeded 会补齐缺失的仓，数据不丢
               ② 若仍不完整（版本已是最新却缺仓），只能删库重建并明确告知用户 */
          const missing = Object.keys(STORES)
            .filter(n => !db.objectStoreNames.contains(n));

          if (missing.length && !req.__retried) {
            const curVer = db.version;
            console.warn('[Idb] 缺少对象仓 ' + missing.join(', ') +
                         '，尝试升级重建（当前 v' + curVer + '）');
            try { db.close(); } catch (e) { }

            // 用「当前版本 + 1」强制触发 onupgradeneeded
            const up = indexedDB.open(IDB_NAME, Math.max(curVer + 1, IDB_VERSION));
            up.onupgradeneeded = req.onupgradeneeded;
            up.onsuccess = () => {
              if (settled) { up.result.close(); return; }
              _db = up.result;
              _db.onversionchange = () => { try { _db.close(); } catch (e) { } _db = null; };
              const still = Object.keys(STORES)
                .filter(n => !_db.objectStoreNames.contains(n));
              if (still.length) {
                console.error('[Idb] 升级后仍缺 ' + still.join(', ') + '，将重建数据库');
                _recreate(resolve, reject, still);
              } else {
                console.info('[Idb] 结构已补齐');
                settled = true;
                resolve(_db);
              }
            };
            up.onerror = () => {
              if (settled) return;
              console.error('[Idb] 升级失败，将重建数据库');
              _recreate(resolve, reject, missing);
            };
            return;
          }

          if (missing.length) {
            _recreate(resolve, reject, missing);
            return;
          }

          _db = db;
          _db.onversionchange = () => { try { _db.close(); } catch (e) { } _db = null; };
          settled = true;
          resolve(_db);
        };

        req.onerror = () => {
          if (settled) return;
          settled = true;
          _openPromise = null;
          reject(req.error || new Error('IndexedDB 打开失败'));
        };

        setTimeout(() => {
          if (settled) return;
          settled = true;
          _openPromise = null;
          reject(new Error('IndexedDB 打开超时'));
        }, 3000);

      } catch (e) {
        _openPromise = null;
        reject(e);
      }
    });

    return _openPromise;
  }

  /* ---------- 事务封装 ---------- */
  function tx(storeNames, mode) {
    return open().then(db => db.transaction(storeNames, mode || 'readonly'));
  }
  /* 把 IDBRequest 包成 Promise */
  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /* ---------- 单条操作 ---------- */
  async function get(store, key) {
    const t = await tx([store]);
    return req(t.objectStore(store).get(key));
  }
  async function put(store, value) {
    const t = await tx([store], 'readwrite');
    const r = await req(t.objectStore(store).put(value));
    return r;
  }
  async function del(store, key) {
    const t = await tx([store], 'readwrite');
    return req(t.objectStore(store).delete(key));
  }
  async function count(store) {
    const t = await tx([store]);
    return req(t.objectStore(store).count());
  }
  async function clear(store) {
    const t = await tx([store], 'readwrite');
    return req(t.objectStore(store).clear());
  }
  async function getAll(store, limit) {
    const t = await tx([store]);
    const os = t.objectStore(store);
    if (limit) {
      // 用游标限量，避免把整表读进内存
      return new Promise((resolve, reject) => {
        const out = [];
        const cr = os.openCursor();
        cr.onsuccess = () => {
          const c = cr.result;
          if (!c || out.length >= limit) return resolve(out);
          out.push(c.value);
          c.continue();
        };
        cr.onerror = () => reject(cr.error);
      });
    }
    return req(os.getAll());
  }

  /* ---------- 批量写 ----------
     12,737 个盘位逐个事务写会非常慢，必须走单事务 bulkPut。 */
  async function bulkPut(store, values, chunkSize) {
    const arr = values || [];
    if (!arr.length) return 0;
    const CH = chunkSize || 2000;
    let written = 0;
    for (let i = 0; i < arr.length; i += CH) {
      const slice = arr.slice(i, i + CH);
      const t = await tx([store], 'readwrite');
      const os = t.objectStore(store);
      await new Promise((resolve, reject) => {
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('事务中止'));
        slice.forEach(v => { try { os.put(v); } catch (e) { /* 单条失败不中断整批 */ } });
      });
      written += slice.length;
    }
    return written;
  }

  /* ---------- 按索引查询 ----------
     filter 为 {index, value} 或 {index, lower, upper}（范围） */
  async function query(store, filter, opts) {
    const o = opts || {};
    const t = await tx([store]);
    const os = t.objectStore(store);
    let source = os;
    let range = null;

    if (filter && filter.index) {
      const ix = os.index(filter.index);
      source = ix;
      if (filter.lower !== undefined) {
        range = IDBKeyRange.bound(filter.lower, filter.upper, !!filter.lowerOpen, !!filter.upperOpen);
      } else if (filter.value !== undefined) {
        range = IDBKeyRange.only(filter.value);
      }
    }

    return new Promise((resolve, reject) => {
      const out = [];
      const cr = source.openCursor(range, o.desc ? 'prev' : 'next');
      cr.onsuccess = () => {
        const c = cr.result;
        if (!c) return resolve(out);
        if (!o.filter || o.filter(c.value)) {
          out.push(c.value);
          if (o.limit && out.length >= o.limit) return resolve(out);
        }
        c.continue();
      };
      cr.onerror = () => reject(cr.error);
    });
  }

  /* ---------- 幂等台账 ----------
     add() 在唯一索引冲突时会抛错 —— 正好用来拦截重复入库 */
  async function ledgerSeen(dedupKey) {
    const v = await get('ledger', dedupKey);
    return !!v;
  }
  async function ledgerMark(dedupKey, extra) {
    try {
      await put('ledger', Object.assign({ dedupKey, at: Date.now() }, extra || {}));
      return true;
    } catch (e) { return false; }
  }
  /* 批量标记，返回真正新增的键（已存在的不计入） */
  async function ledgerMarkMany(keys) {
    const fresh = [];
    const seen = await ledgerFilter(keys);
    keys.forEach(k => { if (!seen.has(k)) fresh.push(k); });
    if (fresh.length) {
      await bulkPut('ledger', fresh.map(k => ({ dedupKey: k, at: Date.now() })));
    }
    return fresh;
  }
  async function ledgerFilter(keys) {
    const set = new Set();
    const t = await tx(['ledger']);
    const os = t.objectStore('ledger');
    await new Promise(resolve => {
      const cr = os.openCursor();
      cr.onsuccess = () => {
        const c = cr.result;
        if (!c) return resolve();
        set.add(c.value.dedupKey);
        c.continue();
      };
      cr.onerror = () => resolve();
    });
    return new Set(keys.filter(k => set.has(k)));
  }

  /* ---------- meta 键值 ---------- */
  async function metaGet(k, d) {
    const v = await get('meta', k);
    return v ? v.v : d;
  }
  async function metaSet(k, v) {
    return put('meta', { k, v, at: Date.now() });
  }

  /* ---------- 容量估算 ---------- */
  async function estimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0,
                 usedPct: e.quota ? (e.usage / e.quota) : 0 };
      }
    } catch (e) { }
    return { usage: 0, quota: 0, usedPct: 0 };
  }

  async function clearAll() {
    const names = Object.keys(STORES);
    for (const n of names) { try { await clear(n); } catch (e) { } }
    return names.length;
  }

  function isOpen() { return !!_db; }

  return {
    available, open, isOpen,
    get, put, del, count, clear, getAll,
    bulkPut, query,
    ledgerSeen, ledgerMark, ledgerMarkMany, ledgerFilter,
    metaGet, metaSet,
    estimate, clearAll,
    STORES
  };
})();
