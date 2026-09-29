/* ============================================================================
   解析器注册表
   ----------------------------------------------------------------------------
   日志格式尚未提供，所以解析做成**注册表 + 可配置规则**：

     新增一种格式 = 新增一个解析器文件并 register()，调用方一行不改。

   注册表按 priority 依次 match()，第一个命中的负责解析；
   全部未命中则回退到通用解析器（靠可配置的正则规则工作）。

   这样即使一份现场样例都没有，链路也是通的：
   通用解析器至少能抽取 SN / 工站 / 结果，样例到位后只需补充规则或加解析器。
   ============================================================================ */

const ParserRegistry = (() => {

  const parsers = [];
  let _seq = 0;

  /**
   * 注册解析器
   * @param {object} p
   *   id        标识
   *   priority  越小越先尝试（默认 100）
   *   match(ctx)  返回 bool —— 这个解析器能不能处理
   *   parse(text, ctx)  返回记录数组（已归一化的对象）
   *   desc      说明，界面上展示
   */
  function register(p) {
    if (!p || !p.id || typeof p.parse !== 'function') {
      throw new Error('解析器必须有 id 与 parse()');
    }
    parsers.push({
      id: p.id,
      name: p.name || p.id,
      desc: p.desc || '',
      priority: p.priority == null ? 100 : p.priority,
      match: typeof p.match === 'function' ? p.match : (() => true),
      parse: p.parse,
      order: _seq++
    });
    parsers.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
    return p.id;
  }

  function unregister(id) {
    const i = parsers.findIndex(p => p.id === id);
    if (i >= 0) parsers.splice(i, 1);
  }

  function all() {
    return parsers.map(p => ({ id: p.id, name: p.name, desc: p.desc, priority: p.priority }));
  }

  /* 选解析器：第一个 match 通过的 */
  function pick(ctx) {
    for (let i = 0; i < parsers.length; i++) {
      try {
        if (parsers[i].match(ctx)) return parsers[i];
      } catch (e) {
        console.warn('[Parser] ' + parsers[i].id + '.match 出错：', e);
      }
    }
    return null;
  }

  /* 跑一个解析器，异常不往上抛 —— 单个文件解析失败不该中断整轮拉取 */
  function run(parser, text, ctx) {
    try {
      const out = parser.parse(text, ctx);
      return Array.isArray(out) ? out : [];
    } catch (e) {
      console.warn('[Parser] ' + parser.id + ' 解析失败：', e.message);
      return [];
    }
  }

  /* --------------------------------------------------------------------------
     内置：通用解析器
     靠配置的正则规则抽取字段，不需要针对具体格式写代码
     -------------------------------------------------------------------------- */
  const DEFAULT_RESULT_MAP = {
    pass: 'pass', ok: 'pass', success: 'pass', good: 'pass',
    fail: 'fail', ng: 'fail', error: 'fail', bad: 'fail',
    abort: 'abort', aborted: 'abort', '异常终止': 'abort', timeout: 'abort',
    '通过': 'pass', '失败': 'fail'
  };

  /* 行式日志：逐行找「键 = 值」或「键: 值」，抽 SN / 工站 / 结果 */
  function genericParse(text, ctx) {
    const cfg = App.cfg;
    const rules = ((cfg.matchRules || {}).keyExtract) || [];
    const out = [];
    const lines = String(text || '').split(/\r?\n/);

    /* 整篇共享的信息（工站、工单）—— 逐行抽一份会重复，先抽一次 */
    const doc = {};
    rules.forEach(r => {
      if (!r.enabled || !r.regex) return;
      try {
        const m = text.match(new RegExp(r.regex, 'i'));
        if (m) doc[r.key] = m[1] != null ? m[1] : m[0];
      } catch (e) { }
    });

    /* 每一行找一个 SN；同一行若有结果词就生成一条记录 */
    const snRe = /(?:SN|Serial_?No|序列号)\s*[:=]\s*([A-Za-z0-9\-_]{6,})/i;
    const resRe = /\b(PASS|FAIL|NG|OK|ABORT|ERROR|TIMEOUT)\b|(通过|失败|异常终止)/i;
    /* 槽位/位号：常见写法 Slot 1 / Slot: 03 / DIMM-A0 / 槽位 5 */
    const slotRe = /(?:Slot|DIMM|槽位|位号|Position)\s*[:=#\s-]*([A-Za-z]*)(\d{1,3})/i;
    const ipRe = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;
    const codeRe = /\b(E-[A-Z]{2,6}-\d{2,4}|0x[0-9A-Fa-f]{4}|ERR[-_]?\d{3,5})\b/i;
    /* 时间戳：行内常见的几种写法。抽不到就留空 ——
       绝不能拿当前时间兜底，否则同一份日志每次解析出的时间都不同，幂等会失效。 */
    const timeRe = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
    const timeOnlyRe = /\b(\d{1,2}):(\d{2}):(\d{2})\b/;

    lines.forEach((line, i) => {
      if (!line || line.length > 2000) return;
      const sm = line.match(snRe);
      if (!sm) return;
      const rm = line.match(resRe);
      const rawRes = rm ? (rm[1] || rm[2]) : '';
      const mapped = rawRes ? (DEFAULT_RESULT_MAP[rawRes.toLowerCase()] || '') : '';

      /* 位置信息尽量抽 —— 有它才能把记录落到具体盘位上。
         抽不到就留空，由 Pipeline 决定是否跳过（宁可不写也不能猜错位置）。 */
      const slotM = line.match(slotRe);
      const ipM = line.match(ipRe);
      const codeM = line.match(codeRe);

      /* 行内时间：优先完整日期时间；只有时分秒时用文件 mtime 的日期补上 */
      let lineTime = null;
      const tm = line.match(timeRe);
      if (tm) {
        lineTime = `${tm[1]}-${String(tm[2]).padStart(2, '0')}-${String(tm[3]).padStart(2, '0')} ` +
                   `${String(tm[4]).padStart(2, '0')}:${tm[5]}:${tm[6] || '00'}`;
      } else {
        const to = line.match(timeOnlyRe);
        if (to) {
          const base = ctx.mtime ? new Date(ctx.mtime) : new Date();
          lineTime = `${Util.todayKey(base)} ` +
                     `${String(to[1]).padStart(2, '0')}:${to[2]}:${to[3]}`;
        }
      }

      const rec = {
        sn: sm[1],
        station: MatchEngine.normalizeStation(cfg, doc['工站'] || '') || ctx.station || '',
        result: mapped,
        // DIMM-A0 这类字母位号无法直接转成盘位号，只取数字部分
        slotIndex: slotM ? Math.max(0, Number(slotM[2]) - 1) : null,
        ip: ipM ? ipM[1] : (doc['服务器IP'] || ''),
        errCode: codeM ? ErrCodeRules.normalizeCode(codeM[1]) : '',
        time: lineTime,
        endTime: lineTime,
        woNo: doc['工单'] || '',
        pn: doc['PN'] || '',
        lineNo: i + 1,
        rawText: Util.truncate(line.trim(), 300),
        sourceFile: ctx.fileName,
        srcPath: ctx.filePath,
        source: ctx.source || 'ftp'
      };
      if (rec.result || rec.station) out.push(rec);
    });

    return out;
  }

  register({
    id: 'generic-line',
    name: '通用行式解析',
    desc: '逐行抽 SN 与结果。日志格式未确定时的兜底；' +
          '可在「系统设置 → 匹配规则」里增加关键项正则来提升抽取率。',
    priority: 1000,
    match: () => true,
    parse: genericParse
  });

  return { register, unregister, all, pick, run, DEFAULT_RESULT_MAP };
})();
