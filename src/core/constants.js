/* ============================================================================
   领域常量 —— 全项目唯一的工站/产能真相源
   ----------------------------------------------------------------------------
   改车间配置只改这个文件。所有派生数据（盘位拓扑、产能、瓶颈、抽样）都由
   这里推导，不允许在别处硬编码设备数或周期。

   数据来源：《Lava_test产品执行规范》§1.1（需求方提供的真实车间配置）
   ============================================================================ */

const APP_NAME = 'Lava_test';
const APP_TITLE = '固态硬盘全段测试看板';
const APP_VERSION = '1.0.0';
const SCHEMA_VERSION = 1;

/* 物理结构常量：除 ICT/BIST/ESS 外，其余工站为「机柜 → 9 台服务器 → 每台 16 盘位」 */
const CAB_SIZE = 9;        // 每个机柜装 9 台服务器
const DISK_PER_SRV = 16;   // 每台服务器 16 个盘位

/* ---------------------------------------------------------------------------
   工站定义
     layout: 'flat'    独立设备（ICT / BIST / ESS）
             'cabinet' 机柜 → 服务器 → 盘位（FUNCTION / FINAL / ORT / CUS）
     cycleMin  单轮时长（分钟）—— ICT 是 6 秒，故为 0.1
     count     设备台数
     sampling  抽样比例（仅 ORT）
   ⚠️ FINAL 的 400 台为需求方估计值，约为主线需求 1.75 倍，待现场复核（规范 §10 🔴#2）
   --------------------------------------------------------------------------- */
const STATIONS = [
  {
    key: 'ICT', name: 'ICT', cn: '在线电路测试', full: 'In-Circuit Test',
    layout: 'flat', unit: '机台', capacity: 1, cycleMin: 0.1, count: 1,
    loads: '单块', color: 'var(--st-ict)', order: 1,
    /* ★ 整线节拍源。
       cycleMin 0.1（6 秒）是**纯测试时间**，不含上下料。
       实测日产能 3000 块 → 有效节拍 1440÷3000 = 28.8 秒/块
       （6 秒测试 + 22.8 秒上下料）。现场明确：**所有工序产能都以 ICT 为准**，
       因此整线节拍取自这里，而非各工序理论产能的最小值。 */
    ratePerDay: 3000,
    isGate: true,
    note: '整线节拍源。6 秒/块是纯测试时间，含上下料实测 3000 块/天（≈28.8 秒/块）。全厂仅此 1 台，停机即整线断料。'
  },
  {
    key: 'FUNCTION', name: 'FUNCTION', cn: '功能测试', full: 'Function Test',
    layout: 'cabinet', unit: '服务器', capacity: DISK_PER_SRV, cycleMin: 30, count: 16,
    loads: '托盘', color: 'var(--st-function)', order: 2,
    note: '允许不满载，须记录实际装载数'
  },
  {
    key: 'BIST', name: 'BIST', cn: '老化', full: 'Built-In Self-Test',
    layout: 'flat', unit: '老化箱', capacity: 256, cycleMin: 28 * 60, count: 19,
    loads: '整箱', color: 'var(--st-bist)', order: 3,
    note: '整箱上下料，推定不允许不满载与中途取料'
  },
  {
    key: 'ESS', name: 'ESS', cn: '环境应力筛选', full: 'Environmental Stress Screening',
    layout: 'flat', unit: 'ESS箱', capacity: 128, cycleMin: 13 * 60, count: 18,
    loads: '整箱', color: 'var(--st-ess)', order: 4,
    note: '箱体异常须整箱连带判废；18 箱为整线需求的 1.42 倍，余量充足'
  },
  {
    key: 'FINAL', name: 'FINAL', cn: '最终测试', full: 'Final Test',
    layout: 'cabinet', unit: '服务器', capacity: DISK_PER_SRV, cycleMin: 31 * 60, count: 311,
    loads: '托盘', color: 'var(--st-final)', order: 5,
    note: '出货前最后一道全检；311 台为整线需求的 1.28 倍，余量偏紧（早期口头估计 400 台，经台账核实为 311）'
  },
  {
    key: 'ORT', name: 'ORT', cn: '持续可靠性抽检', full: 'Ongoing Reliability Test',
    /* ⚠️ ORT 取 33 而非台账明细的 43：
       明细里的 43 台含 28 台借用设备（其中 8 台在「故障机台」区域），
       33 才是台账汇总区声明的自有数量。
       交叉验证：33 × 16 ÷ 7 天 = 75.4 块/天，而整线 3000 块/天的 2.5% 抽检
       需求是 75 块/天 —— 匹配度 99.4%。这个吻合度说明 33 是真实配置。 */
    layout: 'cabinet', unit: '服务器', capacity: DISK_PER_SRV, cycleMin: 7 * 24 * 60, count: 33,
    loads: '抽样 2.5%', color: 'var(--st-ort)', order: 7, sampling: 0.025, bypass: true,
    note: '旁路工序，从 FINAL 产出中抽样，不阻塞主线放行'
  },
  {
    key: 'CUS', name: 'CUS', cn: '客制化', full: 'Customization',
    layout: 'cabinet', unit: '服务器', capacity: DISK_PER_SRV, cycleMin: 3 * 60, count: 41,
    loads: '托盘', color: 'var(--st-cus)', order: 6,
    note: '是否全线通待确认，当前按全线通建模'
  }
];

/* 主线工序顺序（ORT 为旁路抽检，不在主线内）
   ⚠️ 顺序为推定值，待现场确认（规范 §10 🔴#1） */
const MAINLINE = ['ICT', 'FUNCTION', 'BIST', 'ESS', 'FINAL', 'CUS'];

/* 工站索引 */
const ST = {};
STATIONS.forEach(s => { ST[s.key] = s; });

/* 设备编号前缀：机柜 / 服务器 / 独立设备，统一单字母后缀 */
const STATION_CODE = {
  ICT: 'ICT', FUNCTION: 'F', BIST: 'B', ESS: 'E', FINAL: 'N', ORT: 'R', CUS: 'C'
};

/* ---------------------------------------------------------------------------
   盘位状态
     empty       空位
     testing     测试中
     pass        通过
     fail        失败（产品不合格）
     abort       异常终止（数据不完整，非不合格 —— 必须与 fail 严格区分）
     maintenance 维护中
     damaged     损坏
     disabled    禁用
   --------------------------------------------------------------------------- */
const SLOT_STATE = {
  empty:       { label: '空位',     cls: 's-empty' },
  testing:     { label: '测试中',   cls: 's-testing' },
  pass:        { label: '通过',     cls: 's-pass' },
  fail:        { label: '失败',     cls: 's-fail' },
  abort:       { label: '异常终止', cls: 's-abort' },
  maintenance: { label: '维护中',   cls: 's-maint' },
  damaged:     { label: '损坏',     cls: 's-damaged' },
  disabled:    { label: '禁用',     cls: 's-disabled' }
};

/* 设备状态 */
const EQ_STATE = {
  run:   { label: '运行中', cls: 'b-run' },
  idle:  { label: '空闲',   cls: 'b-idle' },
  fault: { label: '故障',   cls: 'b-fault' },
  maint: { label: '维护中', cls: 'b-maint' }
};

/* 工单状态 */
const WO_STATE = {
  wait:    { label: '待生产', cls: 'wo-st-wait' },
  accepted:{ label: '已接单', cls: 'wo-st-accepted' },
  running: { label: '生产中', cls: 'wo-st-running' },
  closed:  { label: '已结单', cls: 'wo-st-closed' }
};

/* ---------------------------------------------------------------------------
   判定结论（不良判定引擎）
     functional    功能性不良 —— 写入不良记录且自动确认
     nonfunctional 非功能性   —— 只留流水，不写不良记录（如机柜侧事件）
     unknown       待确认     —— 写入不良记录但 confirmed=false，等人工确认
   --------------------------------------------------------------------------- */
const VERDICT = {
  functional:    { label: '功能性不良', autoConfirm: true,  toBad: true  },
  nonfunctional: { label: '非功能性',   autoConfirm: false, toBad: false },
  unknown:       { label: '待确认',     autoConfirm: false, toBad: true  }
};

/* 匹配方式（判定规则） */
const MATCH_TYPE = {
  errcode: '错误码',
  station: '工站',
  keyword: '关键词',
  any:     '全部'
};

/* ---------------------------------------------------------------------------
   默认判定规则（可被用户在「不良判定设置」里覆盖）
   元组：[匹配方式, 匹配内容, 判定, 不良类型]
   优先级按数组下标 × 10，升序匹配，首个命中即返回
   ⚠️ 错误码与关键词为占位，须按 SSD 实际测试程序输出补充（规范 §10）
   --------------------------------------------------------------------------- */
const DEFAULT_DEFECT_RULES = [
  ['errcode', 'E-ICT-102',  'functional',  'ICT电气不良'],
  ['errcode', 'E-FN-311',   'functional',  '功能测试失败'],
  ['errcode', 'E-BIST-407', 'functional',  '老化早期失效'],
  ['errcode', 'E-ESS-220',  'functional',  '应力失效'],
  ['errcode', 'E-CUS-118',  'functional',  '客制化失败'],
  ['keyword', 'ReadFail',   'functional',  '读写失败'],
  ['keyword', 'Timeout',    'unknown',     '超时待确认'],
  ['keyword', 'Sel',        'nonfunctional','机柜侧事件']
  // 注意：故意不设 any 兜底规则。
  // 未命中的内容由 classify() 返回 confidence:'none' + 待确认，
  // 若加 any 规则会让「未命中」分支永远不可达，且兜底规则的命中计数被无意义放大。
  // 需要兜底语义时，用户可在「不良判定设置」里自行添加 any 规则。
];

/* ---------------------------------------------------------------------------
   错误码处置策略
   每条码带处置动作，不只是文案 —— 决定是否允许复测、是否锁 SN
   ⚠️ 具体错误码待现场提供（规范 §10）
   --------------------------------------------------------------------------- */
const ERROR_CODE_RULES = [
  { code: 'E-ICT-102',  name: 'ICT 电气不良',   allowRetest: false, action: '直接转 FA',                 lockSn: false, note: '元器件/焊接不良' },
  { code: 'E-FN-311',   name: '功能测试失败',   allowRetest: true,  action: '排除接触后复测 1 次，仍失败转 FA', lockSn: false, note: '接口/固件问题' },
  { code: 'E-BIST-407', name: '老化早期失效',   allowRetest: true,  action: '复测 1 次，仍失败转 FA',      lockSn: false, note: '早期失效（infant mortality）' },
  { code: 'E-ESS-220',  name: '应力失效',       allowRetest: false, action: '直接转 FA',                 lockSn: true,  note: '环境应力后失效，锁定 SN' },
  { code: 'E-CUS-118',  name: '客制化写入失败', allowRetest: true,  action: '重试 1 次，仍失败转 FA',      lockSn: false, note: '客户固件/标签写入失败' }
];

/* 不良类型（记录不良下拉） */
const DEFECT_TYPES = [
  'ICT电气不良', '功能测试失败', '老化早期失效', '应力失效',
  '客制化失败', '读写速率不达标', '外观不良', '其他'
];

/* 报错类型（记录报错下拉 —— 以设备为主体，区别于不良记录） */
const ERROR_TYPES = [
  '设备通讯中断', '测试超时', '进程被中断', '箱体温度告警',
  '服务器掉线', '机柜断电', 'SSH 异常', '其他'
];

/* 数据来源标记 */
const SOURCE = {
  ssh:     { label: 'SSH 巡检',  auto: true  },
  ftp:     { label: 'FTP 拉取',  auto: true  },
  local:   { label: '本地目录',  auto: true  },
  webapp:  { label: 'MES 接口',  auto: true  },
  manual:  { label: '手工录入',  auto: false },
  mock:    { label: '模拟数据',  auto: false }
};

/* 自动来源集合 —— 同步时这些来源的本位置记录会被清理重建，人工录入的不动 */
const AUTO_SOURCES = ['ssh', 'ftp', 'local', 'webapp'];

/* 视图清单 —— data-view 值、标签、渲染函数名（渲染函数在 views/*.js 里注册）
   tab:true 的显示在顶栏标签页；其余由程序化入口进入 */
const VIEWS = [
  { key: 'floor', name: '平面图',   tab: true,  render: 'renderFloor' },
  { key: 'daily', name: '当日报表', tab: true,  render: 'renderDaily' },
  { key: 'stats', name: '产量统计', tab: true,  render: 'renderStats' },
  { key: 'bad',   name: '不良记录', tab: true,  render: 'renderBad' },
  { key: 'error', name: '报错记录', tab: true,  render: 'renderError' },
  { key: 'pull',  name: '实时拉取', tab: true,  render: 'renderPull' },
  { key: 'wo',    name: '工单管理', tab: true,  render: 'renderWo' },
  { key: 'log',   name: '日志分析', tab: true,  render: 'renderLog' },
  { key: 'board', name: '智慧看板', tab: false, render: 'renderBoard' },
  { key: 'trace', name: '追溯查询', tab: false, render: 'renderTrace' }
];

/* 存储键 */
const LS_KEY = 'lava_test_cfg_v1';       // localStorage 配置层
const IDB_NAME = 'lava_test_db';         // IndexedDB 库名
/* ⚠️ 每次给 Idb.STORES 增删对象仓或索引，**必须同时把这个版本号 +1**。
   否则老用户的库停在旧版本，onupgradeneeded 不触发，新仓建不出来，
   访问时报 "One of the specified object stores was not found"，整个视图挂掉。
   v2: 新增 workorders、devices 两个对象仓 */
const IDB_VERSION = 2;

/* 节拍（毫秒） */
const TICK_RENDER_MS = 300 * 1000;       // 主节拍 300s
const TICK_SSH_MS = 60 * 1000;           // SSH 巡检 60s
const TICK_SLT_MS = 5 * 60 * 1000;       // 日志同步 5min
