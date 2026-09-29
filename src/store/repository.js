/* ============================================================================
   存储门面（Repository）—— 上层只调这里，不感知底层后端
   ----------------------------------------------------------------------------
   后端选择顺序：
     1. Idb      IndexedDB         首选，容量大、按索引查询
     2. Local    紧凑 localStorage  降级（file:// 下 Chrome 禁用 IDB 时）
     3. Memory   纯内存             兜底（localStorage 也写不进时）

   为什么需要降级：
     Chrome / Edge 在 file:// 协议下把页面当作不透明来源，IndexedDB 不可用。
     本项目现场部署可能是「双击 HTML」，因此必须有降级路径。

   生产建议：由 Python 桥接托管页面到 http://127.0.0.1:8770/，
            属安全上下文，IndexedDB 全功能可用。

   盘位压缩编码（Local 后端用）：
     cabinetId / serverId / boxId 都可由 (station, equipmentId) 经 Topology 推导，
     因此不必落盘 —— 这是把 12,737 条压进 localStorage 的关键。
     数组位: [state, sn, pn, woNo, result, errCode, startTime, retestRound]
   ============================================================================ */

const Repo = (() => {

  let _backend = null;          // 'idb' | 'local' | 'memory'
  let _ready = null;            // Promise
  let _stats = { slotsWritten: 0, writes: 0 };

  const LS_SLOTS = 'lava_test_slots_v1';
  const LS_TABLES = 'lava_test_tables_v1';
  const LOCAL_TABLE_CAP = 5000;    // 降级后端下每张表的条数上限

  /* 内存镜像：降级后端与读缓存共用。
     key = slotKey → slot 对象（仅存非空盘位；空盘位不占内存不落盘） */
  const _slotMem = new Map();
  const _tableMem = {};            // store 名 → 数组

  /* ==========================================================================
     后端探测与初始化
     ========================================================================== */
  function init() {
    if (_ready) return _ready;
    _ready = (async () => {
      const hasIdb = await Idb.available();
      if (hasIdb) {
        try {
          await Idb.open();
          _backend = 'idb';
          console.info('[Repo] 存储后端：IndexedDB');
          return _backend;
        } catch (e) {
          console.warn('[Repo] IndexedDB 打开失败，降级：', e.message);
        }
      }
      if (LocalStore.available()) {
        _backend = 'local';
        loadLocalSlots();
        loadLocalTables();
        console.warn('[Repo] 存储后端：紧凑 localStorage（降级模式）');
        console.warn('       → 建议由桥接服务托管页面（http://127.0.0.1:8770/）以获得完整容量');
      } else {
        _backend = 'memory';
        console.warn('[Repo] 存储后端：内存（刷新即失，请及时导出备份）');
      }
      return _backend;
    })();
    return _ready;
  }

  function backend() { return _backend || 'uninit'; }
  function isDegraded() { return _backend === 'local' || _backend === 'memory'; }
  function backendLabel() {
    return { idb: 'IndexedDB（完整）', local: '本地存储（降级）', memory: '内存（不持久）', uninit: '未初始化' }[_backend] || '未知';
  }

  /* ==========================================================================
     Local 后端：盘位紧凑读写
     ========================================================================== */
  /* 盘位对象 → 紧凑数组 */
  function packSlot(s) {
    return [
      s.state || 'empty',
      s.sn || '',
      s.pn || '',
      s.woNo || '',
      s.result || '',
      s.errCode || '',
      s.startTime || 0,
      s.retestRound || 0,
      s.source || '',
      s.endTime || 0
    ];
  }
  /* 紧凑数组 → 盘位对象（归属字段由 Topology 反推） */
  function unpackSlot(key, arr) {
    const p = Schema.parseSlotKey(key);
    const eqs = Topology.all(LocalStore.load()).stationsMap[p.station] || [];
    let eq = null;
    for (let i = 0; i < eqs.length; i++) { if (eqs[i].id === p.equipmentId) { eq = eqs[i]; break; } }
    return {
      key,
      station: p.station,
      equipmentId: p.equipmentId,
      slotIndex: p.slotIndex,
      cabinetId: eq ? eq.cabinetId : '',
      serverId: eq ? eq.serverId : '',
      boxId: eq ? eq.boxId : '',
      state: arr[0] || 'empty',
      sn: arr[1] || '',
      pn: arr[2] || '',
      model: '',                     // 可由 PN 经 MatchEngine 推导，不落盘
      woNo: arr[3] || '',
      lot: '',
      result: arr[4] || '',
      errCode: arr[5] || '',
      verdict: '',
      confirmed: undefined,
      startTime: arr[6] || null,
      endTime: arr[9] || null,
      cycleMs: null,
      retestRound: arr[7] || 0,
      source: arr[8] || '',
      updatedAt: Date.now()
    };
  }

  function loadLocalSlots() {
    try {
      const raw = localStorage.getItem(LS_SLOTS);
      if (!raw) return;
      const obj = JSON.parse(raw);
      Object.keys(obj).forEach(k => _slotMem.set(k, unpackSlot(k, obj[k])));
      console.info('[Repo] 已载入 ' + _slotMem.size.toLocaleString() + ' 个非空盘位');
    } catch (e) {
      console.error('[Repo] 盘位数据载入失败：', e);
    }
  }
  function saveLocalSlots() {
    if (_backend !== 'local') return { ok: false, reason: 'not-local' };
    try {
      const obj = {};
      _slotMem.forEach((v, k) => { obj[k] = packSlot(v); });
      localStorage.setItem(LS_SLOTS, JSON.stringify(obj));
      return { ok: true, count: _slotMem.size };
    } catch (e) {
      const isQuota = e && (e.name === 'QuotaExceededError' || e.code === 22);
      if (isQuota) {
        console.error('[Repo] 盘位写入超出配额');
        if (typeof Toast !== 'undefined') {
          Toast.error('盘位数据超出浏览器存储配额。请到「导出中心」备份 JSON，并考虑改用桥接托管模式。');
        }
        return { ok: false, reason: 'quota' };
      }
      return { ok: false, reason: 'error', error: e };
    }
  }
  const saveLocalSlotsSoon = Util.debounce(saveLocalSlots, 800);

  function loadLocalTables() {
    try {
      const raw = localStorage.getItem(LS_TABLES);
      if (!raw) return;
      const obj = JSON.parse(raw);
      Object.keys(obj).forEach(k => { _tableMem[k] = obj[k] || []; });
    } catch (e) {
      console.error('[Repo] 表数据载入失败：', e);
    }
  }
  const saveLocalTablesSoon = Util.debounce(function () {
    if (_backend !== 'local') return;
    try { localStorage.setItem(LS_TABLES, JSON.stringify(_tableMem)); }
    catch (e) {
      const isQuota = e && (e.name === 'QuotaExceededError' || e.code === 22);
      if (isQuota && typeof Toast !== 'undefined') {
        Toast.error('记录数据超出配额，请导出备份后清理旧记录。');
      }
    }
  }, 800);

  /* ==========================================================================
     盘位读写（统一接口）
     ========================================================================== */

  /* 批量读取指定 key 的盘位。返回 Map<key, slot>（只含存在的） */
  async function getSlotsByKeys(keys) {
    await init();
    const out = new Map();
    if (!keys || !keys.length) return out;

    if (_backend === 'idb') {
      // 分块读，避免单个事务过大
      const CH = 3000;
      for (let i = 0; i < keys.length; i += CH) {
        const slice = keys.slice(i, i + CH);
        const t = await Idb.open().then(db => db.transaction(['slots']));
        const os = t.objectStore('slots');
        await new Promise(resolve => {
          t.oncomplete = resolve;
          t.onerror = resolve;
          slice.forEach(k => {
            const r = os.get(k);
            r.onsuccess = () => { if (r.result) out.set(k, r.result); };
          });
        });
      }
      return out;
    }
    keys.forEach(k => { const v = _slotMem.get(k); if (v) out.set(k, v); });
    return out;
  }

  async function getAllSlots() {
    await init();
    if (_backend === 'idb') return Idb.getAll('slots');
    return Array.from(_slotMem.values());
  }

  /* 按工站读盘位（IDB 走索引，降级走内存过滤） */
  async function getSlotsByStation(station) {
    await init();
    if (_backend === 'idb') {
      return Idb.query('slots', { index: 'station', value: station });
    }
    const out = [];
    _slotMem.forEach(v => { if (v.station === station) out.push(v); });
    return out;
  }

  /* 批量写盘位。传入的是完整 slot 对象数组 */
  async function putSlots(slots) {
    await init();
    const arr = (slots || []).filter(Boolean);
    if (!arr.length) return 0;
    _stats.writes++;

    arr.forEach(s => { if (!s.updatedAt) s.updatedAt = Date.now(); });

    if (_backend === 'idb') {
      return Idb.bulkPut('slots', arr);
    }
    // 降级：空盘位从内存移除（省空间），非空盘位写入
    arr.forEach(s => {
      if (s.state === 'empty' && !s.sn) _slotMem.delete(s.key);
      else _slotMem.set(s.key, s);
    });
    _stats.slotsWritten += arr.length;
    saveLocalSlotsSoon();
    return arr.length;
  }

  /* 清空所有盘位（复位用） */
  async function clearSlots() {
    await init();
    if (_backend === 'idb') return Idb.clear('slots');
    _slotMem.clear();
    saveLocalSlotsSoon();
    return 0;
  }

  /* 盘位统计：由 Topology 的容量减去非空盘位，得空位数 */
  async function slotCounts() {
    await init();
    if (_backend === 'idb') {
      return { occupied: await Idb.count('slots') };
    }
    return { occupied: _slotMem.size };
  }

  /* ==========================================================================
     通用表读写（records / bad / error / judgements / archives / logindex）
     ========================================================================== */
  const KEY_PATH = {
    records: 'dedupKey', bad: 'id', error: 'id', judgements: 'id',
    archives: 'id', workorders: 'id', devices: 'id', logindex: 'id', rawfiles: 'path'
  };

  async function put(store, rec) {
    await init();
    if (_backend === 'idb') return Idb.put(store, rec);
    const kp = KEY_PATH[store] || 'id';
    const list = _tableMem[store] = _tableMem[store] || [];
    const i = list.findIndex(x => x[kp] === rec[kp]);
    if (i >= 0) list[i] = rec; else list.unshift(rec);
    if (list.length > LOCAL_TABLE_CAP) list.length = LOCAL_TABLE_CAP;
    saveLocalTablesSoon();
    return rec[kp];
  }

  async function putMany(store, recs) {
    await init();
    const arr = recs || [];
    if (!arr.length) return 0;
    if (_backend === 'idb') return Idb.bulkPut(store, arr);
    const kp = KEY_PATH[store] || 'id';
    const list = _tableMem[store] = _tableMem[store] || [];
    const idx = new Map();
    list.forEach((x, i) => idx.set(x[kp], i));
    arr.forEach(r => {
      const i = idx.get(r[kp]);
      if (i != null) list[i] = r; else { list.unshift(r); idx.set(r[kp], list.length - 1); }
    });
    if (list.length > LOCAL_TABLE_CAP) list.length = LOCAL_TABLE_CAP;
    saveLocalTablesSoon();
    return arr.length;
  }

  async function query(store, filter, opts) {
    await init();
    if (_backend === 'idb') {
      try {
        return await Idb.query(store, filter, opts);
      } catch (e) {
        // 对象仓缺失不该让整个视图崩掉 —— 记下来，返回空集，界面照常渲染
        if (e && /object store/i.test(e.message || '')) {
          console.error('[Repo] 对象仓「' + store + '」不存在：', e.message);
          return [];
        }
        throw e;
      }
    }
    let list = (_tableMem[store] || []).slice();
    if (filter && filter.where) {
      list = list.filter(filter.where);
    } else if (filter && filter.index && filter.value !== undefined) {
      list = list.filter(x => x[filter.index] === filter.value);
    }
    if (filter && filter.from != null) {
      list = list.filter(x => (x[filter.index || 'time'] || 0) >= filter.from);
    }
    if (opts && opts.desc) {
      const f = (opts.sortBy || filter && filter.index || 'time');
      list.sort((a, b) => (b[f] || 0) - (a[f] || 0));
    }
    if (opts && opts.limit) list = list.slice(0, opts.limit);
    return list;
  }

  async function count(store, where) {
    await init();
    if (_backend === 'idb') {
      if (!where) return Idb.count(store);
      const all = await Idb.query(store, null, { filter: where });
      return all.length;
    }
    const list = _tableMem[store] || [];
    return where ? list.filter(where).length : list.length;
  }

  async function remove(store, id) {
    await init();
    if (_backend === 'idb') return Idb.del(store, id);
    const kp = KEY_PATH[store] || 'id';
    const list = _tableMem[store] = _tableMem[store] || [];
    const i = list.findIndex(x => x[kp] === id);
    if (i >= 0) list.splice(i, 1);
    saveLocalTablesSoon();
    return i >= 0;
  }

  async function removeWhere(store, where) {
    await init();
    if (_backend === 'idb') {
      const hits = await Idb.query(store, null, { filter: where });
      for (const h of hits) {
        const kp = KEY_PATH[store] || 'id';
        await Idb.del(store, h[kp]);
      }
      return hits.length;
    }
    const list = _tableMem[store] = _tableMem[store] || [];
    const before = list.length;
    _tableMem[store] = list.filter(x => !where(x));
    saveLocalTablesSoon();
    return before - _tableMem[store].length;
  }

  async function clearTable(store) {
    await init();
    if (_backend === 'idb') return Idb.clear(store);
    _tableMem[store] = [];
    saveLocalTablesSoon();
    return 0;
  }

  /* ==========================================================================
     幂等台账
     ========================================================================== */
  async function ledgerFilter(keys) {
    await init();
    if (!keys || !keys.length) return [];
    if (_backend === 'idb') {
      const seen = await Idb.ledgerFilter(keys);
      return keys.filter(k => seen.has(k));
    }
    const set = new Set((_tableMem.__ledger || []).map(x => x.dedupKey));
    return keys.filter(k => set.has(k));
  }
  async function ledgerMark(keys) {
    await init();
    const arr = Array.isArray(keys) ? keys : [keys];
    if (!arr.length) return 0;
    if (_backend === 'idb') return (await Idb.ledgerMarkMany(arr)).length;
    const list = _tableMem.__ledger = _tableMem.__ledger || [];
    const set = new Set(list.map(x => x.dedupKey));
    let n = 0;
    arr.forEach(k => {
      if (set.has(k)) return;
      list.unshift({ dedupKey: k, at: Date.now() });
      set.add(k); n++;
    });
    if (list.length > LOCAL_TABLE_CAP * 4) list.length = LOCAL_TABLE_CAP * 4;
    saveLocalTablesSoon();
    return n;
  }

  /* ==========================================================================
     meta 键值
     ========================================================================== */
  async function metaGet(k, d) {
    await init();
    if (_backend === 'idb') return Idb.metaGet(k, d);
    const list = _tableMem.__meta || [];
    const hit = list.filter(x => x.k === k)[0];
    return hit ? hit.v : d;
  }
  async function metaSet(k, v) {
    await init();
    if (_backend === 'idb') return Idb.metaSet(k, v);
    const list = _tableMem.__meta = _tableMem.__meta || [];
    const hit = list.filter(x => x.k === k)[0];
    if (hit) hit.v = v; else list.unshift({ k, v, at: Date.now() });
    saveLocalTablesSoon();
    return v;
  }

  /* ==========================================================================
     容量与维护
     ========================================================================== */
  async function estimate() {
    await init();
    if (_backend === 'idb') return Idb.estimate();
    // 降级模式：汇报 localStorage 占用
    let used = 0;
    try {
      used = (localStorage.getItem(LS_SLOTS) || '').length * 2 +
             (localStorage.getItem(LS_TABLES) || '').length * 2 +
             LocalStore.size();
    } catch (e) { }
    return { usage: used, quota: 5 * 1024 * 1024, usedPct: used / (5 * 1024 * 1024) };
  }

  async function clearAll() {
    await init();
    _slotMem.clear();
    Object.keys(_tableMem).forEach(k => { _tableMem[k] = []; });
    if (_backend === 'idb') await Idb.clearAll();
    try {
      localStorage.removeItem(LS_SLOTS);
      localStorage.removeItem(LS_TABLES);
    } catch (e) { }
    return true;
  }

  /* 立即落盘（关闭页面前调用） */
  function flush() {
    if (_backend === 'local') {
      saveLocalSlots();
      try { localStorage.setItem(LS_TABLES, JSON.stringify(_tableMem)); } catch (e) { }
    }
  }

  function stats() { return Util.clone(_stats); }

  return {
    init, backend, backendLabel, isDegraded, flush, stats,
    getSlotsByKeys, getAllSlots, getSlotsByStation, putSlots, clearSlots, slotCounts,
    put, putMany, query, count, remove, removeWhere, clearTable,
    ledgerFilter, ledgerMark, metaGet, metaSet,
    estimate, clearAll
  };
})();
