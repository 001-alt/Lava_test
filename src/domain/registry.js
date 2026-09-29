/* ============================================================================
   设备台账（Registry）—— 真实设备的身份与位置
   ----------------------------------------------------------------------------
   拓扑有两条来源，优先级：**真实台账 > 按工站配置合成**

     合成模式（Topology 现有逻辑）：设备叫 SRV-N-001，机柜叫 CAB-N-01，
       只是按「N 台服务器」这个数量生成的占位结构。
     台账模式（本模块）：设备叫 S35#-3（真实机柜号 + 柜内位号），
       带真实 IP 与型号 —— 现场看到的标号和看板上的一致。

   导入真实台账后应当切到台账模式，否则看板显示的编号现场对不上，
   桥接阶段也没法把巡检到的 IP 对应到具体设备。

   ⚠️ 台账里两类工站的物理形态不同：
        服务器类（FUNCTION/FINAL/ORT/CUS）→ 机柜号 + 柜内位号
        箱体类（BIST/ESS）              → 区域名 + 箱号
      设备 id 因此有两种构成方式，但对外统一成 {station, equipmentId}。 */

const Registry = (() => {

  const SERVER_STATIONS = ['FUNCTION', 'FINAL', 'ORT', 'CUS'];

  /* --------------------------------------------------------------------------
     设备 id 生成
       服务器类：S35#-3   （机柜号 + 柜内位号）
       箱体类：  BIST-61# （区域 + 箱号）
       都缺时退化为 工站-序号

     ⚠️ 台账的「服务器位置」列并不总是数字 —— 有时写的是工站名（'Function'）。
        直接拿来拼 id 会得到 S36#-Function 这种编号，而且同一柜内多行会重名。
        因此只有「看起来是位号」的值才用，否则回退到序号。
     -------------------------------------------------------------------------- */
  const POS_RE = /^\d{1,3}$/;
  function isPos(v) { return POS_RE.test(String(v || '').trim()); }

  function makeId(d, seq) {
    if (d.cabinet && isPos(d.pos)) return d.cabinet + '-' + Number(d.pos);
    if (d.zone && d.box) return d.zone + '-' + d.box;
    if (d.cabinet) return d.cabinet + '-' + (seq + 1);
    if (d.zone) return d.zone + '-' + (seq + 1);
    return (d.station || 'DEV') + '-' + String(seq + 1).padStart(3, '0');
  }

  /* --------------------------------------------------------------------------
     从 Ledger 解析结果生成设备台账
       parsed 为 Ledger.parse() 的返回值
       返回 { devices, stats, warnings }
     -------------------------------------------------------------------------- */
  /* 故障/维修/报废区 —— 这些设备不参与生产统计与排产 */
  const FAULTY_RE = /故障|维修|报废|停用|待修/;

  function fromLedger(parsed, opts) {
    const o = opts || {};
    const devices = [];
    const seen = new Set();
    const warnings = [];
    let faultyCount = 0;

    /* 序号兜底要**按柜（或按区域）独立计数**。
       台账的「服务器位置」列经常不是数字（写的是工站名 'Function'），
       这时只能退回序号；若跨柜累加，同一柜内会得到 S36#-13/S36#-14 这种跳号。 */
    const seqByGroup = {};

    (parsed.active || []).forEach((d, i) => {
      const groupKey = (d.station || '') + '|' + (d.cabinet || d.zone || '');
      seqByGroup[groupKey] = (seqByGroup[groupKey] || 0) + 1;

      const faulty = FAULTY_RE.test((d.zone || '') + ' ' + (d.cabinet || ''));
      if (faulty) { faultyCount++; if (o.skipFaulty !== false) return; }

      const rec = {
        id: makeId(d, seqByGroup[groupKey] - 1),
        station: d.station || '',
        cabinet: d.cabinet || '',
        zone: d.zone || '',
        pos: isPos(d.pos) ? String(Number(d.pos)) : '',
        posRaw: d.pos || '',
        box: d.box || '',
        ip: d.ip || d.ipAlt || '',
        ipAlt: d.ipAlt || '',
        model: d.model || '',
        borrowed: !!d.borrowed,
        faulty,
        // 台账里的原始行号，便于回溯核对
        srcRow: d.row,
        active: true
      };
      // id 冲突时加后缀（同一柜内位号重复等异常数据）
      let id = rec.id, k = 1;
      while (seen.has(id)) { id = rec.id + '_' + (++k); }
      seen.add(id);
      rec.id = id;
      devices.push(rec);
    });

    /* 校验 */
    const byStation = {};
    const ipOwner = {};
    const dupIps = [];
    devices.forEach(d => {
      byStation[d.station || '(未识别)'] = (byStation[d.station || '(未识别)'] || 0) + 1;
      if (!d.ip) return;
      if (ipOwner[d.ip]) dupIps.push({ ip: d.ip, a: ipOwner[d.ip].id, b: d.id });
      else ipOwner[d.ip] = d;
    });
    if (dupIps.length) warnings.push('有 ' + dupIps.length + ' 个 IP 被多台设备占用');
    const noIp = devices.filter(d => !d.ip).length;
    if (noIp) warnings.push('有 ' + noIp + ' 台设备没有 IP，无法接入');
    const noStation = devices.filter(d => !d.station).length;
    if (noStation) warnings.push('有 ' + noStation + ' 台设备未识别工站');
    if (faultyCount) {
      warnings.push('台账里有 ' + faultyCount + ' 台设备位于故障/维修区域，' +
        (o.skipFaulty !== false ? '已排除' : '已保留'));
    }
    const borrowedCount = devices.filter(d => d.borrowed).length;
    if (borrowedCount) warnings.push('其中 ' + borrowedCount + ' 台为借用设备（按在产处理）');

    return {
      devices,
      stats: {
        total: devices.length,
        byStation,
        ipCount: Object.keys(ipOwner).length,
        dupIps,
        noIp,
        noStation,
        cabinetCount: new Set(devices.map(d => d.cabinet).filter(Boolean)).size,
        zoneCount: new Set(devices.map(d => d.zone).filter(Boolean)).size,
        borrowed: devices.filter(d => d.borrowed).length,
        models: countModels(devices)
      },
      warnings
    };
  }

  function countModels(devices) {
    const out = {};
    devices.forEach(d => { if (d.model) out[d.model] = (out[d.model] || 0) + 1; });
    return out;
  }

  /* --------------------------------------------------------------------------
     由台账生成拓扑 —— 与 Topology.all() 同构，可直接喂给现有视图
       返回 { stations, stationsMap, equipment, totalSlots, source:'registry' }
     -------------------------------------------------------------------------- */
  function buildTopology(devices, cfg) {
    const stations = Topology.effectiveStations(cfg);
    const stationsMap = {};
    stations.forEach(s => { stationsMap[s.key] = []; });

    /* 按工站分组，组内保持稳定顺序：
       服务器类按 机柜号 + 位号，箱体类按 区域 + 箱号 */
    const groups = {};
    devices.forEach(d => {
      if (!d.station || !stationsMap[d.station]) return;   // 未识别工站的设备不进拓扑
      (groups[d.station] = groups[d.station] || []).push(d);
    });

    Object.keys(groups).forEach(st => {
      const s = ST[st];
      if (!s) return;
      const cap = s.capacity;
      const list = groups[st].slice().sort((a, b) => {
        const ca = a.cabinet || a.zone || '', cb = b.cabinet || b.zone || '';
        if (ca !== cb) {
          // 规范机柜号（S35#）排在自定义区域名（客户验证/FA验证机）之前
          const ra = /^[A-Za-z]{1,4}\d/.test(ca) ? 0 : 1;
          const rb = /^[A-Za-z]{1,4}\d/.test(cb) ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return ca.localeCompare(cb, 'zh-CN', { numeric: true });
        }
        const pa = parseInt(a.pos || a.box, 10) || 0;
        const pb = parseInt(b.pos || b.box, 10) || 0;
        return pa - pb;
      });

      list.forEach(d => {
        const eq = {
          id: d.id,
          station: st,
          capacity: cap,
          layout: s.layout,
          cabinetId: d.cabinet || '',
          serverId: SERVER_STATIONS.indexOf(st) >= 0 ? d.id : '',
          boxId: SERVER_STATIONS.indexOf(st) < 0 ? d.id : '',
          zone: d.zone || '',
          ip: d.ip || '',
          ipAlt: d.ipAlt || '',
          model: d.model || '',
          borrowed: !!d.borrowed,
          slotKeys: []
        };
        for (let k = 0; k < cap; k++) eq.slotKeys.push(Schema.slotKey(st, d.id, k));
        stationsMap[st].push(eq);
      });
    });

    /* ⚠️ 台账没覆盖的工站要按配置补出来。
       设备台账记录的是「机柜里的服务器」，像 ICT 这种单机台根本不在里面；
       若只按台账建拓扑，ICT 会变成 0 台，整条线的节拍源就消失了。 */
    let synthesized = 0;
    stations.forEach(s => {
      if (stationsMap[s.key] && stationsMap[s.key].length) return;
      if (!s.count) return;
      const eqs = Topology.buildStation(s);
      stationsMap[s.key] = eqs;
      synthesized += eqs.length;
    });

    const equipment = [];
    let totalSlots = 0;
    stations.forEach(s => {
      const list = stationsMap[s.key] || [];
      equipment.push.apply(equipment, list);
      totalSlots += list.length * s.capacity;
    });

    return {
      stations, stationsMap, equipment, totalSlots,
      source: synthesized ? 'registry+synthetic' : 'registry',
      synthesized
    };
  }

  /* --------------------------------------------------------------------------
     设备台账 ↔ 工站配置 的台数对比（导入时给用户看差异）
     -------------------------------------------------------------------------- */
  function diffCounts(devices, cfg) {
    const stations = Topology.effectiveStations(cfg);
    const byStation = {};
    devices.forEach(d => {
      if (!d.station) return;
      byStation[d.station] = (byStation[d.station] || 0) + 1;
    });
    return stations.map(s => {
      const led = byStation[s.key] || 0;
      return {
        key: s.key, name: s.name, cn: s.cn, color: s.color,
        configured: s.count, ledger: led,
        diff: led - s.count,
        capacityPerUnit: s.capacity,
        online: led * s.capacity
      };
    });
  }

  /* 由台账推导各工站设备数（用于「按台账更新工站配置」） */
  function countsFromLedger(devices) {
    const out = {};
    devices.forEach(d => {
      if (!d.station) return;
      out[d.station] = (out[d.station] || 0) + 1;
    });
    return out;
  }

  /* --------------------------------------------------------------------------
     IP 映射相关
     -------------------------------------------------------------------------- */

  /* 校验：返回问题清单，供界面高亮 */
  function validate(devices) {
    const issues = { dupIp: {}, invalidIp: {}, noIp: [], sameIpBothCols: [] };
    const owner = {};
    devices.forEach(d => {
      const ip = String(d.ip || '').trim();
      if (!ip) { issues.noIp.push(d.id); return; }
      if (!Util.isIp(ip)) { (issues.invalidIp[d.id] = ip); return; }
      if (owner[ip] && owner[ip] !== d.id) {
        (issues.dupIp[ip] = issues.dupIp[ip] || [owner[ip]]).push(d.id);
      } else {
        owner[ip] = d.id;
      }
      // 上位机 IP 与服务器 IP 相同 —— 通常是填错
      if (d.ipAlt && d.ip === d.ipAlt) issues.sameIpBothCols.push(d.id);
    });
    return issues;
  }

  /* 导出为 CSV（供桥接服务直接读） */
  function toCsv(devices, headers) {
    const rows = devices.map(d => [
      d.station, d.cabinet, d.zone, d.pos, d.box, d.id, d.ip, d.ipAlt, d.model,
      d.borrowed ? '借用' : '自有', d.srcRow
    ]);
    return Util.toCsv(headers || [
      '工站', '机柜', '区域', '位号', '箱号', '设备编号', 'IP', '备用IP', '型号', '归属', '台账行号'
    ], rows);
  }

  /* 导出为桥接服务用的简洁清单 */
  function toBridgeList(devices) {
    return devices.filter(d => d.ip && d.station).map(d => ({
      ip: d.ip,
      station: d.station,
      equipmentId: d.id,
      cabinet: d.cabinet,
      zone: d.zone
    }));
  }

  return {
    SERVER_STATIONS, makeId,
    fromLedger, buildTopology, diffCounts, countsFromLedger,
    validate, toCsv, toBridgeList, countModels
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Registry;
