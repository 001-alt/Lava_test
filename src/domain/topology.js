/* ============================================================================
   领域拓扑 —— 工站 → 机柜/设备 → 服务器/箱体 → 盘位
   ----------------------------------------------------------------------------
   纯函数，不碰 DOM，不碰存储。给定工站配置，产出确定的物理拓扑。

   盘位总数（真实车间配置）：
     ICT        1 × 1    =     1
     FUNCTION  12 × 16   =   192   (2 机柜)
     BIST      14 × 256  = 3,584
     ESS       12 × 128  = 1,536
     FINAL    400 × 16   = 6,400   (45 机柜)
     ORT       32 × 16   =   512   (4 机柜)
     CUS       32 × 16   =   512   (4 机柜)
                          ─────────
                          12,737
   ============================================================================ */

const Topology = (() => {

  /* 应用配置覆盖：现场改设备数/周期不必改代码 */
  function effectiveStations(cfg) {
    const ov = (cfg && cfg.stationOverride) || {};
    return STATIONS.map(s => {
      const o = ov[s.key];
      if (!o) return s;
      const merged = Object.assign({}, s);
      if (o.count != null)     merged.count = Math.max(0, Number(o.count));
      if (o.cycleMin != null)  merged.cycleMin = Math.max(0.001, Number(o.cycleMin));
      if (o.capacity != null)  merged.capacity = Math.max(1, Number(o.capacity));
      merged.overridden = true;
      return merged;
    });
  }
  function stationOf(key, cfg) {
    return effectiveStations(cfg).filter(s => s.key === key)[0] || null;
  }

  function cabPrefix(key) { return 'CAB-' + STATION_CODE[key]; }
  function srvPrefix(key) { return 'SRV-' + STATION_CODE[key]; }
  function flatPrefix(key) {
    if (key === 'ICT')  return 'ICT';
    if (key === 'BIST') return 'OVEN-B';
    return 'ESS-E';
  }

  /* --------------------------------------------------------------------------
     生成一个工站的设备清单
     返回 Equipment[]：
       { id, station, capacity, layout,
         cabinetId?, serverId?, boxId?,          // 三种归属，按 layout 取用
         slotKeys: [...] }                       // 预生成盘位 key，避免重复拼接
     -------------------------------------------------------------------------- */
  function buildStation(station) {
    const out = [];
    const n = station.count;
    const padW = n > 99 ? 3 : 2;

    if (station.layout === 'flat') {
      const pre = flatPrefix(station.key);
      for (let i = 1; i <= n; i++) {
        const id = pre + '-' + Util.pad(i, padW);
        const eq = {
          id, station: station.key, capacity: station.capacity,
          layout: 'flat', cabinetId: '', serverId: '', boxId: '',
          slotKeys: []
        };
        // 箱类设备（BIST/ESS）带箱号，供「同箱追溯」
        if (station.capacity >= 100) eq.boxId = id;
        for (let k = 0; k < station.capacity; k++) {
          eq.slotKeys.push(Schema.slotKey(station.key, id, k));
        }
        out.push(eq);
      }
      return out;
    }

    /* cabinet 布局：机柜（每柜 CAB_SIZE 台服务器）→ 服务器（DISK_PER_SRV 盘位） */
    const srvPre = srvPrefix(station.key);
    const cabPre = cabPrefix(station.key);
    for (let i = 1; i <= n; i++) {
      const ci = Math.floor((i - 1) / CAB_SIZE) + 1;
      const id = srvPre + '-' + Util.pad(i, padW);
      const eq = {
        id, station: station.key, capacity: station.capacity,
        layout: 'cabinet',
        cabinetId: cabPre + '-' + Util.pad(ci, 2),
        serverId: id,
        boxId: '',
        cabIndex: ci,
        slotKeys: []
      };
      for (let k = 0; k < station.capacity; k++) {
        eq.slotKeys.push(Schema.slotKey(station.key, id, k));
      }
      out.push(eq);
    }
    return out;
  }

  /* --------------------------------------------------------------------------
     拓扑来源
     ----------------------------------------------------------------------------
     有真实设备台账时用台账（设备编号 = 真实机柜号+位号），否则按工站配置合成。
     台账模式让看板上的编号与现场标号一致，桥接才能把巡检到的 IP 对应到设备。

     用模块级 _registry 而不是给每个函数加参数：Topology 的调用点遍布各视图
     （summary/cabinets/locate/siblings…），逐个传参既啰嗦又容易漏。
     -------------------------------------------------------------------------- */
  let _registry = null;
  let _cache = null;
  let _cacheKey = '';

  function setRegistry(devices) {
    _registry = (devices && devices.length) ? devices : null;
    invalidate();
  }
  function hasRegistry() { return !!_registry; }
  function registrySize() { return _registry ? _registry.length : 0; }

  function all(cfg) {
    const stations = effectiveStations(cfg);
    const stationKey = stations.map(s => s.key + ':' + s.count + ':' + s.capacity).join(',');
    // 台账模式下缓存键要含台账指纹，否则换了台账仍返回旧拓扑
    const key = (_registry
      ? 'reg:' + _registry.length + ':' + _registry.map(d => d.id).join(',').length + ':' +
        (_registry[0] ? _registry[0].id : '')
      : 'syn') + '|' + stationKey;
    if (_cache && _cacheKey === key) return _cache;

    if (_registry) {
      _cache = Registry.buildTopology(_registry, cfg);
    } else {
      const stationsMap = {};
      const equipment = [];
      let totalSlots = 0;
      stations.forEach(s => {
        const eqs = buildStation(s);
        stationsMap[s.key] = eqs;
        equipment.push.apply(equipment, eqs);
        totalSlots += eqs.length * s.capacity;
      });
      _cache = { stations, stationsMap, equipment, totalSlots, source: 'synthetic' };
    }
    _cacheKey = key;
    return _cache;
  }

  function invalidate() { _cache = null; _cacheKey = ''; }

  /* --------------------------------------------------------------------------
     机柜视图：把同一 cabinetId 的服务器聚在一起
     返回 [{ id, station, servers:[...] }]
     -------------------------------------------------------------------------- */
  function cabinets(cfg, stationKey) {
    const topo = all(cfg);
    const list = stationKey ? (topo.stationsMap[stationKey] || []) : topo.equipment;
    const byCab = {};
    list.forEach(eq => {
      if (!eq.cabinetId) return;
      (byCab[eq.cabinetId] = byCab[eq.cabinetId] || []).push(eq);
    });
    return Object.keys(byCab).sort().map(id => {
      const servers = byCab[id].sort((a, b) => a.id.localeCompare(b.id));
      return {
        id,
        station: servers[0].station,
        servers,
        slotCount: servers.reduce((a, s) => a + s.capacity, 0)
      };
    });
  }

  function cabinetCount(cfg, stationKey) {
    return cabinets(cfg, stationKey).length;
  }

  /* --------------------------------------------------------------------------
     定位：给定盘位 key 返回完整位置描述
     -------------------------------------------------------------------------- */
  function locate(cfg, slotKey) {
    const p = Schema.parseSlotKey(slotKey);
    const s = stationOf(p.station, cfg);
    if (!s) return null;
    const eqs = all(cfg).stationsMap[p.station] || [];
    const eq = eqs.filter(e => e.id === p.equipmentId)[0];
    if (!eq) return null;
    return {
      station: p.station, stationName: s.name, stationCn: s.cn,
      equipmentId: eq.id, equipment: eq,
      slotIndex: p.slotIndex,
      cabinetId: eq.cabinetId || '',
      serverId: eq.serverId || '',
      boxId: eq.boxId || '',
      // 人类可读的位置串
      label: [
        s.name,
        eq.cabinetId ? eq.cabinetId : '',
        eq.id,
        '位' + (p.slotIndex + 1)
      ].filter(Boolean).join(' · ')
    };
  }

  /* 反向：给定工站 + 设备 + 盘位序号，返回 key */
  function keyOf(station, equipmentId, slotIndex) {
    return Schema.slotKey(station, equipmentId, slotIndex);
  }

  /* 某台设备的盘位 key 列表 */
  function slotKeysOf(cfg, station, equipmentId) {
    const eqs = all(cfg).stationsMap[station] || [];
    const eq = eqs.filter(e => e.id === equipmentId)[0];
    return eq ? eq.slotKeys : [];
  }

  /* 某工站全部盘位 key */
  function stationSlotKeys(cfg, station) {
    const eqs = all(cfg).stationsMap[station] || [];
    const out = [];
    eqs.forEach(e => { for (let i = 0; i < e.capacity; i++) out.push(e.slotKeys[i]); });
    return out;
  }

  /* 同箱：返回同属一个箱体/机柜的全部盘位 key（用于连带判定）
     scope='box'   BIST/ESS 箱体
     scope='server' 单台服务器
     scope='cabinet' 整个机柜（9 台服务器） */
  function siblings(cfg, slotKey, scope) {
    const loc = locate(cfg, slotKey);
    if (!loc) return [];
    const s = scope || (loc.boxId ? 'box' : 'cabinet');
    if (s === 'server') return loc.equipment.slotKeys.slice();
    if (s === 'box')    return loc.equipment.slotKeys.slice();
    // cabinet：该柜下所有服务器
    const cabs = cabinets(cfg, loc.station);
    const cab = cabs.filter(c => c.id === loc.cabinetId)[0];
    if (!cab) return loc.equipment.slotKeys.slice();
    const out = [];
    cab.servers.forEach(sv => { for (let i = 0; i < sv.capacity; i++) out.push(sv.slotKeys[i]); });
    return out;
  }

  /* --------------------------------------------------------------------------
     汇总：拓扑层面的容量数字（不依赖运行时数据）
     -------------------------------------------------------------------------- */
  function summary(cfg) {
    const topo = all(cfg);
    return topo.stations.map(s => {
      const eqs = topo.stationsMap[s.key] || [];
      const online = eqs.length * s.capacity;
      const daily = s.cycleMin > 0 ? online * (1440 / s.cycleMin) : 0;
      const cabs = s.layout === 'cabinet' ? cabinetCount(cfg, s.key) : 0;
      return {
        station: s.key, name: s.name, cn: s.cn, color: s.color,
        layout: s.layout, unit: s.unit,
        eqCount: eqs.length, cabCount: cabs,
        capacityPerUnit: s.capacity, online,
        cycleMin: s.cycleMin, daily,
        sampling: s.sampling || null,
        bypass: !!s.bypass,
        note: s.note || ''
      };
    });
  }

  return {
    effectiveStations, stationOf,
    buildStation, all, invalidate,
    setRegistry, hasRegistry, registrySize,
    cabinets, cabinetCount,
    locate, keyOf, slotKeysOf, stationSlotKeys, siblings,
    summary,
    cabPrefix, srvPrefix, flatPrefix
  };
})();
