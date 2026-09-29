/* ============================================================================
   产能计算 —— 纯函数
   ----------------------------------------------------------------------------
   日产能 = 设备数 × 单台容量 × (1440 分钟 ÷ 单轮时长)

   ⚠️ 良率口径未定（规范 §10 🔴#4）：
      「良率 = 一次通过率」还是「含复测」结果差别很大。
      这里把口径显式参数化，默认 firstPass，界面须标注口径来源。
      口径确定后只改 DEFAULT_YIELD_MODE 一处。
   ============================================================================ */

const Capacity = (() => {

  const DEFAULT_YIELD_MODE = 'firstPass';   // firstPass | includeRetest

  /* 理论日产能（不考虑换料/停机/复测） */
  function dailyThroughput(station) {
    if (!station || !station.cycleMin) return 0;
    return station.count * station.capacity * (1440 / station.cycleMin);
  }

  /* --------------------------------------------------------------------------
     产能概览
     ----------------------------------------------------------------------------
     整线节拍有两种确定方式：
       1) **有节拍源（gate）** —— 以该工序的实测日产能为整线节拍。
          本项目 ICT 即节拍源（现场明确「所有产能都跟 ICT 走」）。这时
          其它工序的「理论产能」只用于判断**跟不跟得上**，不用于定节拍。
       2) 无节拍源时退化为「取各工序理论日产能的最小值」。

     为什么不能一律取最小值：
       理论产能用的是纯测试时间，不含上下料。ICT 标称 6 秒/块 → 理论 14,400/天，
       但含上下料的实测只有 3000/天（28.8 秒/块）。若取理论最小值，
       ICT 会被算成产能大户，真瓶颈反而被掩盖。
     -------------------------------------------------------------------------- */
  function overview(cfg) {
    const rows = Topology.summary(cfg).map(s => {
      const st = Topology.stationOf(s.station, cfg) || {};
      const theoretical = s.daily;
      const measured = st.ratePerDay || null;
      // 有效日产能：有实测值用实测，否则用理论
      const effective = measured != null ? measured : theoretical;
      return Object.assign({}, s, {
        /* daily 一律表示**有效日产能**（有实测用实测，否则用理论）——
           视图层拿它直接显示，不该关心用的是哪套数。
           理论值另存 theoretical，仅在需要说明「理论≠实际」时使用。 */
        daily: effective,
        theoretical,
        measured,
        effective,
        isGate: !!st.isGate,
        hasMeasured: measured != null,
        // 实测与理论的差距（用于提示「理论值不可直接用于排产」）
        measureGap: measured != null && theoretical > 0
          ? 1 - measured / theoretical : null
      });
    });

    const gate = rows.filter(r => r.isGate)[0] || null;
    const others = rows.filter(r => !r.isGate && !r.bypass);

    // 相对最弱的工序（决定是否跟得上）
    const weakest = others.length
      ? others.reduce((a, b) => (a.effective < b.effective ? a : b))
      : null;

    const lineRate = gate ? gate.effective : (weakest ? weakest.effective : 0);
    const maxDaily = rows.reduce((a, b) => Math.max(a, b.effective), 1);

    rows.forEach(r => {
      // 节拍源存在时，它才是「决定整线节拍的那道工序」
      r.isBottleneck = gate ? r.isGate : (weakest && r.station === weakest.station);
      r.ratioToLine = lineRate ? r.effective / lineRate : 0;
      r.barPct = maxDaily ? r.effective / maxDaily : 0;
      // 跟不上整线节拍的工序 —— 这才是真正要盯的
      r.shortfall = !r.bypass && !r.isGate && lineRate > 0 && r.effective < lineRate;
      r.gapToLine = r.effective - lineRate;
    });

    return {
      rows,
      gate,
      weakest,
      bottleneck: gate || weakest,
      lineRate,
      shortfalls: rows.filter(r => r.shortfall)
    };
  }

  /* 单站利用率 = 已占用盘位 / 同时在线容量 */
  function utilization(stat) {
    if (!stat || !stat.online) return 0;
    return stat.used / stat.online;
  }

  /* --------------------------------------------------------------------------
     良率
     ⚠️ 关键口径：异常终止（abort）不计入分母。
        abort 是数据不完整（断电/超时/取料），不是产品不合格。
        混入分母会让良率失真 —— 见《产品执行规范》§6.1
     -------------------------------------------------------------------------- */
  function yieldOf(counts, mode) {
    const c = counts || {};
    const pass = c.pass || 0;
    const fail = c.fail || 0;
    const denom = pass + fail;             // 分母不含 abort / empty
    if (!denom) return { pct: null, pass, fail, abort: c.abort || 0, denom: 0, mode: mode || DEFAULT_YIELD_MODE };
    return {
      pct: pass / denom,
      pass, fail,
      abort: c.abort || 0,
      denom,
      mode: mode || DEFAULT_YIELD_MODE,
      // 口径说明，界面上必须显示，避免不同人理解不同
      formula: 'PASS ÷ (PASS + FAIL)，不含异常终止'
    };
  }

  /* 盘点一组盘位记录 */
  function countSlots(slots) {
    const c = { total: 0, empty: 0, used: 0, testing: 0, pass: 0, fail: 0, abort: 0, other: 0 };
    (slots || []).forEach(s => {
      c.total++;
      const st = s.state;
      if (st === 'empty') c.empty++;
      else c.used++;
      if (st === 'testing') c.testing++;
      else if (st === 'pass') c.pass++;
      else if (st === 'fail') c.fail++;
      else if (st === 'abort') c.abort++;
      else if (st !== 'empty') c.other++;
    });
    return c;
  }

  /* --------------------------------------------------------------------------
     瓶颈分析 / 优化建议
     -------------------------------------------------------------------------- */
  function advice(cfg, stats) {
    const ov = overview(cfg);
    const out = [];
    if (!ov.lineRate) return out;

    /* ① 说明节拍是从哪来的 —— 这决定了后面所有判断的依据 */
    const gate = ov.gate;
    if (gate) {
      out.push({
        level: 'info',
        text: `整线节拍以 <b>${gate.name}</b> 为基准：<b>${Math.round(ov.lineRate).toLocaleString()} 块/天</b>` +
              (gate.hasMeasured
                ? `（实测值；理论值 ${Math.round(gate.theoretical).toLocaleString()} 块/天用的是纯测试时间，` +
                  `未含上下料，不能直接用于排产）`
                : '') + '。'
      });
    }

    /* ② 跟不上的工序 —— 最关键的一条，优先级最高 */
    ov.shortfalls.forEach(r => {
      const need = Math.ceil(r.eqCount * ov.lineRate / r.effective) - r.eqCount;
      out.push({
        level: 'bad',
        text: `<b>${r.name}（${r.cn}）跟不上整线节拍</b>：当前 ${r.eqCount} ${r.unit} 只有 ` +
              `<b>${Math.round(r.effective).toLocaleString()}</b> 块/天，` +
              `而整线需要 ${Math.round(ov.lineRate).toLocaleString()}，缺口 ` +
              `${Math.round(ov.lineRate - r.effective).toLocaleString()} 块/天（仅达 ` +
              `${(r.ratioToLine * 100).toFixed(0)}%）。` +
              (need > 0 ? `约需再增加 <b>${need} ${r.unit}</b>，或压缩单轮时长。` : '')
      });
    });

    /* ③ 紧贴节拍的工序 —— 距 15% 以内，任一波动就掉队 */
    ov.rows.forEach(r => {
      if (r.bypass || r.isGate) return;
      if (r.shortfall) return;                       // 已在 ② 里报过
      if (r.ratioToLine < 1.15) {
        out.push({
          level: 'warn',
          text: `<b>${r.name}</b> 为整线需求的 ${r.ratioToLine.toFixed(2)} 倍` +
                `（${Math.round(r.effective).toLocaleString()} 块/天），余量偏紧 —— ` +
                `停机、换型或复测增加都可能直接压线。`
        });
      }
    });

    /* ④ 节拍源本身的单点风险 */
    if (gate) {
      out.push({
        level: 'warn',
        text: `<b>${gate.name} 单点风险</b>：只有 ${gate.eqCount} ${gate.unit}，且是整线节拍源 —— ` +
              `它停机不是「产能下降」，而是<b>整线断料</b>。` +
              `应当是优先级最高的预防性维护对象，建议配备机或应急方案。`
      });
    }

    /* ⑤ 冗余提示 */
    ov.rows.forEach(r => {
      if (r.bypass || r.isGate) return;
      if (r.ratioToLine >= 2) {
        out.push({
          level: 'info',
          text: `${r.name} 配置 ${r.eqCount} ${r.unit}，可支撑 ${Math.round(r.effective).toLocaleString()} 块/天` +
                `（整线需求的 ${r.ratioToLine.toFixed(1)} 倍），余量充足。`
        });
      }
    });

    return out;
  }

  /* 给定批量，估算通过整线所需天数（串行部分，不含 ORT 旁路） */
  function leadTimeDays(cfg, qty) {
    const ov = overview(cfg);
    if (!ov.lineRate) return null;
    const cycleSum = MAINLINE.reduce((a, k) => {
      const s = Topology.stationOf(k, cfg);
      return a + (s ? s.cycleMin : 0);
    }, 0);
    return (qty / ov.lineRate) + (cycleSum / 1440);
  }

  return {
    DEFAULT_YIELD_MODE,
    dailyThroughput, overview, utilization,
    yieldOf, countSlots, advice, leadTimeDays
  };
})();
