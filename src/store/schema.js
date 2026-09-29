/* ============================================================================
   数据模式（Schema）—— 记录形状与默认值的唯一真相源
   ----------------------------------------------------------------------------
   分两层，因为它们的体积和读写特征完全不同：

   ┌ 配置层（Cfg）   小、启动即需、同步读     → localStorage
   └ 数据层（DB）    大、按索引查、异步批量写 → IndexedDB（不可用时降级）

   ⚠️ 改字段必须同时改 migrate.js 的迁移函数，否则老存档读不出来。
   ============================================================================ */

const Schema = (() => {

  /* ==========================================================================
     配置层默认值 —— localStorage，键 LS_KEY
     ========================================================================== */
  function defaultConfig() {
    return {
      schemaVersion: SCHEMA_VERSION,
      createdAt: Date.now(),

      /* 工站配置覆盖：允许现场改设备数/周期而不改代码。
         键为工站 key，值为部分覆盖字段（count/cycleMin/capacity）
         ⚠️ FINAL 的 400 台待核实（规范 §10 🔴#2）——改这里即可 */
      stationOverride: {},

      /* 判定规则表（不良判定设置）。空数组 = 用 DEFAULT_DEFECT_RULES 初始化 */
      defectRules: [],

      /* 错误码处置策略（可覆盖内置 ERROR_CODE_RULES） */
      errorCodeRules: [],

      /* 匹配规则中心 */
      matchRules: {
        stationAlias: [],       // [{pattern, station, note}]  工站别名归一
        pnModel:     [],        // [{key, model, note}]        PN/关键词 → 机型
        ipToLocation: [],       // [{ip, station, cabinetId, serverId, slotIndex, note}]
        keyExtract: [           // 从日志正文按正则抽字段
          { key: 'SN',       regex: '(?:SN|Serial_?No|序列号)\\s*[:=]\\s*([A-Za-z0-9\\-_]{6,})', enabled: true },
          { key: 'PN',       regex: '(?:PN|Part_?No|料号)\\s*[:=]\\s*([A-Za-z0-9\\-_.]{4,})',    enabled: true },
          { key: '工站',     regex: '(?:Station|工站|工序)\\s*[:=]\\s*([A-Za-z0-9\\-_]{2,})',     enabled: true },
          { key: '工单',     regex: '(?:WO|Work_?Order|工单)\\s*[:=]\\s*([A-Za-z0-9\\-_]{4,})',   enabled: true },
          { key: '批次',     regex: '(?:Lot|批次)\\s*[:=]\\s*([A-Za-z0-9\\-_]{3,})',              enabled: true },
          { key: '温度',     regex: '(?:温度|Temp)\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)',              enabled: true }
        ],
        minScore: 60
      },

      /* PN 预设：PN/料号关键词 → 工单系列，拉取后自动归类 */
      pnPresets: [
        { id: 'pn_lava960',  pnCode: 'LVA-SSD-960G', workOrderType: 'Lava 960G',  matchMode: 'includes', description: '960G 系列' },
        { id: 'pn_lava192',  pnCode: 'LVA-SSD-1T92', workOrderType: 'Lava 1.92T', matchMode: 'includes', description: '1.92T 系列' },
        { id: 'pn_lava384',  pnCode: 'LVA-SSD-3T84', workOrderType: 'Lava 3.84T', matchMode: 'includes', description: '3.84T 系列' },
        { id: 'pn_lava768',  pnCode: 'LVA-SSD-7T68', workOrderType: 'Lava 7.68T', matchMode: 'includes', description: '7.68T 系列' }
      ],

      /* 字段映射：日志字段 → 系统字段（可在「字段管理」里改） */
      fieldMapping: {
        sn: 'SN', pn: 'PN', station: 'Station', result: 'Result',
        cabinet: '机柜', server: '服务器', slot: '盘位',
        startTime: '开始时间', endTime: '结束时间', errCode: '错误码'
      },

      /* 自定义字段定义（各视图附加列） */
      fieldDefs: [],

      /* 数据接入四通道配置
         ⚠️ 凭据（密码/密钥）不进这里，只存桥接侧 config.yaml */
      channels: {
        ssh:      { enabled: true,  user: 'root', port: 22, logRoot: '/var/log/lava', intervalSec: 60 },
        ftp:      { enabled: true,  host: '', port: 21, user: '', basePath: '/lava/logs', passive: true,
                    bridgeUrl: 'http://127.0.0.1:8770' },
        webapp:   { enabled: false, baseUrl: '', token: '', endpoints: { workorders: '/api/workorder-options', records: '/api/test-records' } },
        localDir: { enabled: true,  path: '' },
        manual:   { enabled: true }
      },

      /* FTP 扫描根 */
      scanRoots: [
        { id: 'r_ict',      name: 'ICT 日志',      path: '/lava/logs/ICT',      kind: 'log',    enabled: true },
        { id: 'r_function', name: 'FUNCTION 日志', path: '/lava/logs/FUNCTION', kind: 'log',    enabled: true },
        { id: 'r_bist',     name: 'BIST 日志',     path: '/lava/logs/BIST',     kind: 'log',    enabled: true },
        { id: 'r_ess',      name: 'ESS 日志',      path: '/lava/logs/ESS',      kind: 'log',    enabled: true },
        { id: 'r_final',    name: 'FINAL 日志',    path: '/lava/logs/FINAL',    kind: 'log',    enabled: true },
        { id: 'r_cus',      name: 'CUS 日志',      path: '/lava/logs/CUS',      kind: 'log',    enabled: true },
        { id: 'r_ort',      name: 'ORT 日志',      path: '/lava/logs/ORT',      kind: 'log',    enabled: true },
        { id: 'r_config',   name: '工单/台账配置', path: '/lava/config',        kind: 'config', enabled: true }
      ],

      /* 解析规则表（可配置解析的核心，见 ingest/rule-config.js） */
      parseRules: [],

      /* 系统设置 */
      settings: {
        autoRefresh: false,        // 自动刷新开关
        autoPull: false,           // 定时自动拉取
        onlyNew: true,             // 增量：只拉未见过/mtime 变化的文件
        maxFilesPerRun: 80,        // 单轮最多拉取文件数
        scanDepth: 4,              // FTP 扫描深度
        refreshSec: 60,            // 拉取间隔
        abnormalMin: 30,           // 异常判定阈值（分钟）
        keepRawDays: 30,           // 原始日志留档天数
        slotRenderMode: 'auto'     // auto | dom | canvas
      },

      /* UI 偏好 */
      ui: {
        curView: 'floor',
        stationFilter: '',
        folded: {},
        badFilter: 'all',
        traceQuery: '',
        tablePageSize: 100
      }
    };
  }

  /* ==========================================================================
     数据层记录形状
     ========================================================================== */

  /* 盘位（IDB store: slots，key = slotKey）
     12,737 条 —— 本项目最大的表，字段名刻意取短以压缩体积 */
  function slotKey(station, equipmentId, slotIndex) {
    return station + '|' + equipmentId + '|' + slotIndex;
  }
  function parseSlotKey(key) {
    const p = String(key).split('|');
    return { station: p[0], equipmentId: p[1], slotIndex: Number(p[2]) };
  }
  /* 空盘位不落库（省 80% 空间）：读不到即视为空 */
  function newSlot(o) {
    return {
      key: slotKey(o.station, o.equipmentId, o.slotIndex),
      station: o.station,
      cabinetId: o.cabinetId || '',
      serverId: o.serverId || '',
      equipmentId: o.equipmentId,
      slotIndex: o.slotIndex,
      boxId: o.boxId || '',            // BIST/ESS 箱号，供同箱追溯
      state: o.state || 'empty',       // SLOT_STATE 的键
      sn: o.sn || '',
      pn: o.pn || '',
      model: o.model || '',
      woNo: o.woNo || '',
      lot: o.lot || '',
      result: o.result || '',          // pass | fail | abort（与 state 区分：abort≠fail）
      errCode: o.errCode || '',
      verdict: o.verdict || '',        // functional | nonfunctional | unknown
      confirmed: o.confirmed,
      retestRound: o.retestRound || 0,
      startTime: o.startTime || null,
      endTime: o.endTime || null,
      cycleMs: o.cycleMs || null,
      source: o.source || '',          // SOURCE 的键
      updatedAt: Date.now()
    };
  }

  /* 测试记录（IDB store: records，key = dedupKey）—— 幂等入库的核心 */
  function dedupKey(r) {
    // 优先用业务键；SN/工站/结束时间缺一不可，缺则退化为来源文件+行号
    if (r.sn && r.station && (r.endTime || r.time)) {
      return [r.sn, r.station, (r.endTime || r.time)].join('|');
    }
    return 'raw|' + (r.sourceFile || '') + '|' + (r.lineNo == null ? '' : r.lineNo);
  }

  /* 不良记录（IDB store: bad）—— 以产品为主体 */
  function newBad(o) {
    return {
      id: o.id || Util.uid('bad'),
      day: o.day || Util.todayKey(),
      time: o.time || Date.now(),
      station: o.station || '',
      cabinetId: o.cabinetId || '',
      serverId: o.serverId || '',
      slotIndex: o.slotIndex == null ? null : o.slotIndex,
      boxId: o.boxId || '',
      sn: o.sn || '',
      pn: o.pn || '',
      model: o.model || '',
      woNo: o.woNo || '',
      type: o.type || '',              // DEFECT_TYPES
      errCode: o.errCode || '',
      verdict: o.verdict || 'unknown',
      confirmed: o.confirmed === true,
      confirmedBy: o.confirmedBy || '',
      confirmedAt: o.confirmedAt || null,
      judgementId: o.judgementId || '',
      retestRound: o.retestRound || 0,
      note: o.note || '',
      source: o.source || 'manual',
      updatedAt: Date.now()
    };
  }

  /* 报错记录（IDB store: error）—— 以设备/机柜为主体，区别于不良记录 */
  function newError(o) {
    return {
      id: o.id || Util.uid('err'),
      day: o.day || Util.todayKey(),
      time: o.time || Date.now(),
      firstTime: o.firstTime || o.time || Date.now(),
      lastTime: o.lastTime || o.time || Date.now(),
      station: o.station || '',
      cabinetId: o.cabinetId || '',
      serverId: o.serverId || '',
      equipmentId: o.equipmentId || '',
      boxId: o.boxId || '',
      slotIndex: o.slotIndex == null ? null : o.slotIndex,
      sn: o.sn || '',
      type: o.type || '',              // ERROR_TYPES
      message: o.message || '',
      errCode: o.errCode || '',
      count: o.count || 1,
      handled: o.handled === true,
      source: o.source || 'manual',
      dedupKey: o.dedupKey || '',      // 同日同位置同类型合并
      updatedAt: Date.now()
    };
  }

  /* 判定流水（IDB store: judgements）—— 不可变审计，只增不改 */
  function newJudgement(o) {
    return {
      id: o.id || Util.uid('jdg'),
      at: o.at || Date.now(),
      source: o.source || 'manual',
      rawText: o.rawText || '',
      errCode: o.errCode || '',
      station: o.station || '',
      cabinetId: o.cabinetId || '',
      slotIndex: o.slotIndex == null ? null : o.slotIndex,
      sn: o.sn || '',
      verdict: o.verdict || 'unknown',
      ruleId: o.ruleId || '',
      confidence: o.confidence || 'none',   // rule | none
      confirmed: o.confirmed === true,
      confirmedBy: o.confirmedBy || '',
      confirmedAt: o.confirmedAt || null,
      confirmNote: o.confirmNote || '',
      badId: o.badId || ''                  // 反查关联的不良记录
    };
  }

  /* 工单 */
  function newWorkOrder(o) {
    return {
      id: o.id || Util.uid('wo'),
      no: o.no || '',
      orderNo: o.orderNo || '',
      pn: o.pn || '',
      model: o.model || '',
      customer: o.customer || '',
      qty: o.qty || 0,
      process: o.process || MAINLINE.slice(),
      plan: o.plan || {},                  // {工站: 计划数}
      status: o.status || 'wait',          // WO_STATE 的键
      createdAt: o.createdAt || Date.now(),
      startDate: o.startDate || '',
      endDate: o.endDate || '',
      acceptedBy: o.acceptedBy || '',
      acceptedAt: o.acceptedAt || null,
      closedBy: o.closedBy || '',
      closedAt: o.closedAt || null,
      closeNote: o.closeNote || '',
      locked: o.locked === true,
      note: o.note || ''
    };
  }

  /* 归档（工单结单后，盘位复位前的产量留存） */
  function newArchive(o) {
    return {
      id: o.id || Util.uid('arc'),
      woId: o.woId || '',
      woNo: o.woNo || '',
      station: o.station || '',
      cabinetId: o.cabinetId || '',
      serverId: o.serverId || '',
      boxId: o.boxId || '',
      pn: o.pn || '',
      model: o.model || '',
      pass: o.pass || 0,
      fail: o.fail || 0,
      abort: o.abort || 0,
      releasedAt: o.releasedAt || Date.now()
    };
  }

  /* 日志文件索引 */
  function newLogIndex(o) {
    return {
      id: o.id || Util.uid('log'),
      path: o.path || '',
      name: o.name || '',
      station: o.station || '',
      size: o.size || 0,
      mtime: o.mtime || null,
      pulledAt: o.pulledAt || Date.now(),
      parsed: o.parsed || 0,               // 解析出的记录条数
      hits: o.hits || {},                  // 关键词命中统计
      error: o.error || ''
    };
  }

  return {
    defaultConfig,
    slotKey, parseSlotKey, newSlot, dedupKey,
    newBad, newError, newJudgement, newWorkOrder, newArchive, newLogIndex
  };
})();
