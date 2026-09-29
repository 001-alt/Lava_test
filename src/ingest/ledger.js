/* ============================================================================
   设备台账解释器
   ----------------------------------------------------------------------------
   把设备台账（xlsx）翻译成看板能用的设备清单。

   真实台账长这样（不规整，是人工维护的）：
     r1-r8    汇总区：工站 | 设备数 | 在制槽位数 | 4.0.0 数量 | 4.2.0 数量 | 切换时间
     r9       表头：机柜号 | 分类 | 设备型号 | 服务器位置 | 工位 | 工位 | 上位机 | 服务器IP
     r10+     明细：**机柜号只在每组首行出现**，其余行继承上一行的机柜；
                   工站同理靠「分类/工位」列向下继承

   因此解析的关键是「向下填充」：先把机柜号、工站补全到每一行，再做统计。
   对识别不了的列不做猜测，记入 warnings 让人工核对。
   ============================================================================ */

const Ledger = (() => {

  /* 工站关键词 → 标准工站 key。顺序有意义：先匹配更具体的关键词 */
  const STATION_PATTERNS = [
    [/bist/i,      'BIST'],
    [/ess/i,       'ESS'],
    [/ort/i,       'ORT'],
    [/cus/i,       'CUS'],
    [/final/i,     'FINAL'],
    [/function|func\b/i, 'FUNCTION'],
    [/ict|在线电路/i, 'ICT']
  ];

  /* 非本站设备的标记（借用的、拆走的、其他厂商的样机） */
  const NON_PRODUCTION = /WTS|借用|无设备|德伽|鸾起|待部署|^\/$/;

  function detectStation(text) {
    const s = String(text || '');
    if (!s) return '';
    for (let i = 0; i < STATION_PATTERNS.length; i++) {
      if (STATION_PATTERNS[i][0].test(s)) return STATION_PATTERNS[i][1];
    }
    return '';
  }

  const isIp = v => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(String(v || '').trim());

  function cell(row, col) {
    if (!row) return '';
    const v = row[col - 1];
    return v == null ? '' : String(v).trim();
  }

  /* --------------------------------------------------------------------------
     表头识别
     ----------------------------------------------------------------------------
     ⚠️ 一张工作表里可能有多张子表，且列含义不同。本项目实际数据就是：
        表1（r9 起）  机柜号|分类|设备型号|服务器位置|工位|工位|上位机|服务器IP
                      描述「机柜里的服务器」
        表2（r429 起）工站|设备型号||分类|||IP
                      描述「BIST/ESS 箱体」，其中「分类」列装的其实是**箱号**（61#）
     所以必须逐表识别表头、各自解析列，不能假设全表一套列。
     -------------------------------------------------------------------------- */
  const HEADER_TOKENS = ['机柜号', '柜号', '分类', '类别', '设备型号', '型号', '服务器位置',
    '位置', '槽位', '箱号', '工位', '工站', '上位机', '上位机IP', '服务器IP', 'IP', '服务器', '类型'];

  /* 阈值取 3 而不是 2：
     汇总区表头（类型|工站|量产设备数|…）也含「类型+工站」两个词，
     阈值 2 会把它也认成明细表头，导致汇总区被吞掉、后续列全错。
     明细表头至少命中 3 个（如 机柜号/分类/设备型号/服务器位置/工位…）。 */
  function isHeaderRow(row) {
    if (!row) return false;
    let hits = 0;
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] || '').trim();
      if (!v) continue;
      if (HEADER_TOKENS.indexOf(v) >= 0) hits++;
      else if (/^IP$/i.test(v) || /IP$/.test(v)) hits++;
    }
    return hits >= 3;
  }

  /* 把工作表切成若干「表头 + 明细」的块 */
  function splitTables(rows) {
    const blocks = [];
    let cur = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      if (isHeaderRow(r)) {
        cur = { headerIdx: i, rows: [] };
        blocks.push(cur);
        continue;
      }
      if (cur) cur.rows.push({ idx: i, row: r });
    }
    return blocks;
  }

  /* 按表头名解析列位置。返回 { 列名: 列号(1起) } */
  function resolveColumns(header) {
    const find = (names) => {
      for (let c = 0; c < header.length; c++) {
        const v = String(header[c] || '').trim();
        if (names.indexOf(v) >= 0) return c + 1;
      }
      // 退化：包含匹配
      for (let c = 0; c < header.length; c++) {
        const v = String(header[c] || '').trim();
        if (!v) continue;
        for (let i = 0; i < names.length; i++) {
          if (v.indexOf(names[i]) >= 0) return c + 1;
        }
      }
      return 0;
    };
    /* 「工位」可能出现两列，取全部 */
    const all = (name) => {
      const out = [];
      for (let c = 0; c < header.length; c++) {
        if (String(header[c] || '').trim() === name) out.push(c + 1);
      }
      return out;
    };
    const stationCols = all('工位').concat(all('工站'));
    return {
      cabinet: find(['机柜号', '柜号']),
      /* ⚠️ 「分类」与「类别」要分开取。
         表1 用「分类」装 量产_final 这类品类；
         表2 的「分类」装的却是箱号（61#），真实品类在「类别」列。
         混为一谈会把箱号当成品类。 */
      category: find(['分类']),
      subCategory: find(['类别']),
      model: find(['设备型号', '型号']),
      pos: find(['服务器位置', '位置', '槽位', '箱号']),
      stationCols: stationCols,
      station: find(['工位', '工站']),
      ipUp: find(['上位机IP', '上位机', 'IP']),
      ipSrv: find(['服务器IP']),
      all: all
    };
  }

  /* 箱号形态：61# / 4# / 110# —— 表2 的「分类」列装的是它 */
  const BOX_RE = /^\d{1,3}#$/;

  /* 机柜号的形态：字母前缀 + 数字 + 可选 #（如 S37# / G16 / 3#）
     ⚠️ 不能只看「非空」，台账里 A 列会混进「故障机台」「新增新华3服务器」这类标签，
        必须靠形态筛掉，否则会被当成机柜名。 */
  const CABINET_RE = /^[A-Za-z]{0,4}\d{1,3}#?$/;

  /* 定位汇总区表头：含「工站」且含「量产设备数」的那一行
     汇总区的数字列不在固定位置（本项目实际在 F~K 列），必须按列名取。 */
  function findSummaryHeaderIndex(rows, beforeIdx) {
    for (let i = 0; i < (beforeIdx < 0 ? Math.min(rows.length, 20) : beforeIdx); i++) {
      const r = rows[i] || [];
      const has = (kw) => r.some(v => String(v || '').indexOf(kw) >= 0);
      if (has('工站') && has('设备数')) return i;
    }
    return -1;
  }

  /* --------------------------------------------------------------------------
     解析
       返回 {
         summary:  [{station, deviceCount, slotCount, v400, v420, note}],
         devices:  [{row, cabinet, zone, category, model, pos, station, ip, ipAlt, note, skipped}],
         stats:    {byStation, byCabinet, ipCount, dupIps, warnings},
         headerRow
       }
     -------------------------------------------------------------------------- */
  /* --------------------------------------------------------------------------
     解析
       返回 {
         summary:  [{station, deviceCount, slotCount, v400, v420, note}],
         devices:  [{row, table, cabinet, zone, box, category, model, pos,
                     station, ip, ipAlt, note, skipped}],
         stats:    {byStation, byCabinet, ipCount, dupIps, warnings},
         tables, warnings
       }
     -------------------------------------------------------------------------- */
  function parse(sheet) {
    const rows = (sheet && sheet.rows) || [];
    const blocks = splitTables(rows);
    if (!blocks.length) throw new Error('在台账里找不到表头行（应有「机柜号」或「工站」+「型号」等表头）');

    const warnings = [];
    const devices = [];

    /* 汇总区：第一张表头之前的行 */
    const summary = parseSummary(rows.slice(0, blocks[0].headerIdx), warnings);

    /* 逐块解析明细 */
    blocks.forEach((blk, bi) => {
      const header = rows[blk.headerIdx] || [];
      const COL = resolveColumns(header);
      parseBlock(blk, bi, header, COL, devices, warnings);
    });

    /* ---------- 统计 ---------- */
    const active = devices.filter(d => (d.ip || d.ipAlt) && !d.skipped);

    const byStation = {};
    active.forEach(d => {
      const k = d.station || '(未识别)';
      byStation[k] = byStation[k] || { count: 0, ips: new Set(), cabinets: new Set(), models: {} };
      byStation[k].count++;
      byStation[k].ips.add(d.ip || d.ipAlt);
      if (d.cabinet) byStation[k].cabinets.add(d.cabinet);
      if (d.model) byStation[k].models[d.model] = (byStation[k].models[d.model] || 0) + 1;
    });

    /* 归属归集：优先真实机柜号，其次区域名（BIST/ESS 这类箱体组） */
    const byCabinet = {};
    active.forEach(d => {
      const k = d.cabinet || d.zone || '(无归属)';
      const e = byCabinet[k] = byCabinet[k] || {
        count: 0, stations: {}, servers: [], isCabinet: !!d.cabinet, zone: d.zone || ''
      };
      e.count++;
      const st = d.station || '(未识别)';
      e.stations[st] = (e.stations[st] || 0) + 1;
      e.servers.push(d);
    });

    /* IP 重复检查 */
    const ipSeen = {};
    const dupIps = [];
    active.forEach(d => {
      [d.ip, d.ipAlt].forEach(ip => {
        if (!ip) return;
        if (ipSeen[ip]) { dupIps.push({ ip, rows: [ipSeen[ip].row, d.row] }); return; }
        ipSeen[ip] = d;
      });
    });

    const unassigned = active.filter(d => !d.station);
    if (unassigned.length) {
      warnings.push('有 ' + unassigned.length + ' 台设备未识别出工站（所在分组没有工站信息可继承）');
    }
    if (dupIps.length) warnings.push('有 ' + dupIps.length + ' 个 IP 重复出现');

    /* 机柜内服务器数分布（便于发现「每柜 9 台」的假设是否成立） */
    const cabSizes = Object.keys(byCabinet)
      .filter(k => byCabinet[k].isCabinet)
      .map(k => byCabinet[k].count);
    const sizeDist = {};
    cabSizes.forEach(n => sizeDist[n] = (sizeDist[n] || 0) + 1);

    return {
      summary,
      devices,
      active,
      stats: {
        totalRows: devices.length,
        activeCount: active.length,
        skippedCount: devices.length - active.length,
        ipCount: Object.keys(ipSeen).length,
        dupIps,
        byStation,
        byCabinet,
        cabinetCount: Object.keys(byCabinet).filter(k => byCabinet[k].isCabinet).length,
        zoneCount: Object.keys(byCabinet).filter(k => !byCabinet[k].isCabinet).length,
        unassigned: unassigned.length,
        cabSizeDist: sizeDist
      },
      tables: blocks.map((b, i) => ({
        index: i,
        headerRow: b.headerIdx + 1,
        rowCount: b.rows.length,
        columns: resolveColumns(rows[b.headerIdx] || [])
      })),
      warnings
    };
  }

  /* --------------------------------------------------------------------------
     汇总区：第一张表头之前的「工站 | 设备数 | 槽位数 | 4.0.0 | 4.2.0」块
     数字列位置不固定（本项目实际在 F~K 列），按列名取
     -------------------------------------------------------------------------- */
  function parseSummary(rows, warnings) {
    const out = [];
    /* 找汇总区自己的表头 */
    let hIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      const has = (kw) => r.some(v => String(v || '').indexOf(kw) >= 0);
      if (has('工站') && (has('设备数') || has('数量'))) { hIdx = i; break; }
    }
    const SC = (() => {
      if (hIdx < 0) return null;
      const h = rows[hIdx] || [];
      const find = (kw) => {
        for (let c = 0; c < h.length; c++) {
          if (String(h[c] || '').indexOf(kw) >= 0) return c + 1;
        }
        return 0;
      };
      return {
        type: find('类型'),
        station: find('工站'),
        device: find('量产设备数') || find('设备数'),
        slot: find('槽位'),
        v400: find('4.0.0'),
        v420: find('4.2.0'),
        pending: find('待调试'),
        switchAt: find('切换时间')
      };
    })();
    if (!SC) {
      if (rows.length) warnings.push('未找到汇总区表头，「台账声明设备数」将缺失');
      return out;
    }

    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const joined = r.filter(Boolean).join(' ').trim();
      if (!joined) continue;

      const stText = cell(r, SC.station);
      const st = detectStation(stText) || detectStation(cell(r, SC.type || 2));
      const numOf = (c) => {
        if (!c) return null;
        const v = cell(r, c);
        if (!v) return null;
        const n = Number(String(v).replace(/[^\d.-]/g, ''));
        return isNaN(n) ? null : n;
      };

      if (!st) {
        if (joined.length > 4) out.push({ station: '', note: joined });
        continue;
      }
      out.push({
        station: st,
        stationText: stText || cell(r, SC.type || 2),
        deviceCount: numOf(SC.device),
        slotCount: numOf(SC.slot),
        v400: numOf(SC.v400),
        v420: numOf(SC.v420),
        pending: numOf(SC.pending),
        switchAt: SC.switchAt ? cell(r, SC.switchAt) : '',
        note: ''
      });
    }
    return out;
  }

  /* --------------------------------------------------------------------------
     解析一个「表头 + 明细」块
     -------------------------------------------------------------------------- */
  function parseBlock(blk, bi, header, COL, devices, warnings) {
    const isBoxTable = !COL.cabinet;          // 没有机柜号列 → 箱体表
    let curCabinet = '';
    let curZone = '';
    let curStation = '';
    const rejected = [];

    blk.rows.forEach(({ idx, row: r }) => {
      if (!r.some(v => v !== '')) return;     // 整行空

      const a = COL.cabinet ? cell(r, COL.cabinet) : cell(r, 1);
      const catRaw = COL.category ? cell(r, COL.category) : '';
      const subCat = COL.subCategory ? cell(r, COL.subCategory) : '';
      const st1 = COL.station ? cell(r, COL.station) : '';
      const stCols = (COL.stationCols || []).map(c => cell(r, c)).filter(Boolean);
      const ipUp = COL.ipUp ? cell(r, COL.ipUp) : '';
      const ipSrv = COL.ipSrv ? cell(r, COL.ipSrv) : '';

      /* --- A 列 / 首列的三种含义 ---
         1) 机柜号（S37#）   → 更新当前机柜
         2) 分类（量产_final）→ 组内其余行的首列装的是分类，不是机柜
         3) 区域名（BIST/OKN/ESS）→ 箱体表的工站名 */
      let aCategory = '';
      let aStation = '';
      if (a) {
        if (CABINET_RE.test(a) && COL.cabinet) {
          curCabinet = a; curZone = '';
        } else if (detectStation(a) && !/^量产/.test(a)) {
          // 首列直接就是工站名（箱体表）
          aStation = detectStation(a);
          curZone = a; curCabinet = '';
        } else if (/^(量产|试产|无设备|WTS|德伽|鸾起|借用|调试)/.test(a)) {
          aCategory = a;
        } else if (/^[A-Za-z一-龥]{1,8}$/.test(a)) {
          /* 自定义区域名（如 OKN）—— 特征同样是「短标签、无数字、无空格」，
             与内置工站词一样作为区域处理，不当作机柜。 */
          curZone = a; curCabinet = '';
        } else if (!/^(类型|工站|机柜号|设备型号|分类|类别)/.test(a)) {
          rejected.push({ row: idx + 1, value: a });
        }
      }

      /* --- 箱号：箱体表的「分类」列装的是 61# 这种箱号 --- */
      const box = BOX_RE.test(catRaw) ? catRaw : '';
      /* --- 品类：箱体表在「类别」列，服务器表在「分类」列 --- */
      const categoryText = box ? subCat
        : (BOX_RE.test(subCat) ? catRaw : (catRaw || subCat || aCategory));

      /* --- 工站识别链 ---
         分类/类别 → 各工位列 → 首列（箱体表的工站名）→ 当前区域继承 */
      const stNow = detectStation(categoryText) ||
                    stCols.map(detectStation).filter(Boolean)[0] ||
                    detectStation(st1) ||
                    aStation ||
                    detectStation(curZone);
      if (stNow) curStation = stNow;

      /* ⚠️ 工位列里会混进设备型号。
         箱体表首行是工站名（BIST），其余行却是型号（鸾起:phoenix-E-S256-BI）——
         这是原表合并单元格被拆开后的形态。
         型号里的厂商名（鸾起/德伽）和非量产标记（借用）字形重合，
         若不过滤，型号会被当成「借用设备」标记，整批设备被误丢。
         型号的判别特征：含冒号、或明显偏长。 */
      const stColsClean = stCols.filter(v => v && !/[:：]/.test(v) && v.length <= 20);
      const stColsStation = stColsClean.filter(v => detectStation(v));
      const raw = [categoryText, subCat, st1].concat(stColsStation).join(' ').trim();

      /* 标记扫描：品类 + 位置 + **全部工位列**，但不含型号列。
         ⚠️ 「WTS借用设备」这个标记在列之间漂移 —— 同一段数据里
            有的行写在「服务器位置」列，有的行写在第二个「工位」列，
            只查其中一列会漏掉一半。
         不含型号列是因为型号里的厂商名（鸾起/德伽）是正常生产设备。 */
      const posText = COL.pos ? cell(r, COL.pos) : '';
      const markText = [categoryText, subCat, posText].concat(stColsClean).join(' ');

      /* ⚠️ 只有「无设备」才算非生产。
         「WTS借用设备」**不算** —— 现场确认那些是调拨给本产线在用的设备，
         产线台账里所有列出的设备都是正在用的。早期版本把借用设备排除，
         导致设备数少算，并连带把产能算错。 */
      const isNonProd = /无设备|待部署/.test(markText);

      const rec = {
        row: idx + 1,
        table: bi,
        cabinet: curCabinet,
        zone: curZone,
        box,
        category: categoryText,
        model: COL.model ? cell(r, COL.model) : '',
        pos: COL.pos ? cell(r, COL.pos) : (box || cell(r, 4)),
        stationRaw: raw,
        station: isNonProd ? '' : (stNow || curStation),
        ip: isIp(ipUp) ? ipUp : '',
        ipAlt: isIp(ipSrv) ? ipSrv : '',
        note: isNonProd ? markText.replace(/\s+/g, ' ').trim() : '',
        // 借用设备计入生产台账，但打个标记，便于界面上单独筛选
        borrowed: /借用/.test(markText),
        nonProd: isNonProd,
        skipped: isNonProd || (!isIp(ipUp) && !isIp(ipSrv))
      };

      // 既没 IP 也没归属 —— 纯注释行
      if (!rec.ip && !rec.ipAlt && !rec.cabinet && !rec.zone && !rec.box) return;
      devices.push(rec);
    });

    if (rejected.length) {
      const sample = rejected.slice(0, 3).map(x => 'r' + x.row + '「' + x.value + '」').join('、');
      warnings.push('第 ' + (bi + 1) + ' 张表的首列有 ' + rejected.length +
        ' 处既不是机柜号也不是区域名，已忽略（如 ' + sample + '）');
    }
  }


  /* --------------------------------------------------------------------------
     与当前看板配置对比
       stations 由调用方传入（来自 Topology），本模块不直接依赖它 ——
       这样纯逻辑可在 Node 下单测，也避免 ingest 层耦合 domain 层。
     返回每个工站：配置设备数 / 台账明细统计 / 台账汇总声明 / 差异
     -------------------------------------------------------------------------- */
  function diff(stations, parsed) {
    const list = stations || [];
    return list.map(s => {
      const led = parsed.stats.byStation[s.key];
      const ledCount = led ? led.count : 0;
      const declared = (parsed.summary.filter(x => x.station === s.key)[0] || {}).deviceCount;
      return {
        key: s.key,
        name: s.name,
        cn: s.cn,
        configured: s.count,
        capacityPerUnit: s.capacity,
        // 逐行统计出来的台数
        ledger: ledCount,
        // 台账汇总区里人工维护的台数（可能落后于明细，是版本切换期的常见现象）
        declared: declared == null ? null : declared,
        diff: ledCount - s.count,
        diffDeclared: declared == null ? null : (declared - s.count),
        cabinetCount: led ? led.cabinets.size : 0,
        ipCount: led ? led.ips.size : 0,
        models: led ? led.models : {}
      };
    });
  }

  return { parse, diff, detectStation, STATION_PATTERNS, NON_PRODUCTION };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Ledger;
