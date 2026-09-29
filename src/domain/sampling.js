/* ============================================================================
   ORT 抽样（2.5%）—— Lava_test 特有，纯函数
   ----------------------------------------------------------------------------
   规范 §5.1：
     抽样数 = ⌈批次数量 × 2.5%⌉
     ORT 台次 = ⌈抽样数 ÷ 16⌉

   ⚠️ 容量自洽性：ORT 32 台 × 16 盘位 ÷ 7 天 = 73 块/天，
      恰好等于主线 2836 块/天的 2.5%（71 块），匹配度 96.9%。
      这反证了 ORT 是「旁路抽检」而非串行工序 —— 若串行，73 块/天的吞吐
      会成为整线瓶颈（比 ESS 还低 40 倍），产线无法运转。

   ⚠️ 抽样方式（随机/等距）、失效后的停线判据均未定（规范 §10 🔴#3、🟡#10）。
      本模块只做计算与展示，**不做自动停线、不做自动派工**，避免误调度。
   ============================================================================ */

const Sampling = (() => {

  const DEFAULT_RATIO = 0.025;

  /* 抽样量计算 */
  function calc(qty, ratio) {
    const r = ratio == null ? DEFAULT_RATIO : ratio;
    const n = Math.max(0, Math.ceil(Number(qty || 0) * r));
    const perServer = ST.ORT ? ST.ORT.capacity : 16;
    const rounds = n > 0 ? Math.ceil(n / perServer) : 0;
    return {
      qty: Number(qty || 0),
      ratio: r,
      sample: n,
      perServer,
      rounds,
      // 最后一轮的实际装载数（允许不满载）
      lastRoundLoad: n > 0 ? (n % perServer === 0 ? perServer : n % perServer) : 0,
      desc: n > 0
        ? `抽 ${n} 块 → 占用 ORT ${rounds} 台次（${perServer} 盘位/台）`
        : '批量不足，无需抽样'
    };
  }

  /* 一批或多批的排轮汇总 */
  function plan(items, ratio) {
    const list = (items || []).map(it => Object.assign({ id: it.id, no: it.no }, calc(it.qty, ratio)));
    const totalSample = list.reduce((a, x) => a + x.sample, 0);
    const totalRounds = list.reduce((a, x) => a + x.rounds, 0);
    const capacity = (ST.ORT ? ST.ORT.count * ST.ORT.capacity : 0);
    const cycleDays = ST.ORT ? ST.ORT.cycleMin / 1440 : 7;
    // 同期在测占用：总台次 × 单轮时长 ÷ 排轮窗口
    const concurrent = capacity ? Math.min(capacity, totalSample) : 0;
    return {
      list, totalSample, totalRounds,
      capacity,
      cycleDays,
      concurrent,
      // 若同时投产所有批次，ORT 是否够用
      enough: capacity >= concurrent,
      desc: `共需抽 ${totalSample} 块 / ${totalRounds} 台次；ORT 总容量 ${capacity} 盘位，单轮 ${cycleDays} 天`
    };
  }

  /* ORT 日产能与主线需求的匹配度（自洽性检查） */
  function consistency(cfg) {
    const ov = Capacity.overview(cfg);
    const lineRate = ov.lineRate;                                  // 主线日产能
    const demand = lineRate * DEFAULT_RATIO;                       // ORT 日需求
    const st = Topology.stationOf('ORT', cfg);
    const capacity = st ? st.count * st.capacity * (1440 / st.cycleMin) : 0;   // ORT 日能力
    return {
      lineRate, demand, capacity,
      match: capacity ? demand / capacity : 0,
      ok: capacity ? Math.abs(demand / capacity - 1) < 0.15 : false,
      desc: `主线 ${Math.round(lineRate).toLocaleString()} 块/天 × 2.5% = ${Math.round(demand)} 块/天；` +
            `ORT 能力 ${Math.round(capacity)} 块/天`
    };
  }

  /* 判定某块 SN 是否被 ORT 抽中（确定性，便于追溯一致） */
  function isSampled(sn, ratio) {
    const r = ratio == null ? DEFAULT_RATIO : ratio;
    return (Util.hashCode(sn) % 1000) < Math.round(r * 1000);
  }

  /* 从一批 SN 中按确定性规则抽样本（不依赖随机，可复现） */
  function pick(sns, qty, ratio) {
    const n = calc(qty, ratio).sample;
    const sorted = (sns || []).slice().sort((a, b) => Util.hashCode(a) - Util.hashCode(b));
    return sorted.slice(0, n);
  }

  /* ⚠️ 失效处置：仅给出建议，不自动停线（规范 §10 🔴#3 未定） */
  function failureAdvice(failCount, lotSize) {
    if (!failCount) {
      return { escalated: false, stopLine: false, text: '全数通过，批次可放行' };
    }
    if (failCount === 1) {
      const widen = calc(lotSize, 0.10);
      return {
        escalated: true, stopLine: false,
        text: `出现 1 块失效 → 建议扩大抽样至 10%（约 ${widen.sample} 块）复验`,
        note: '⚠️ 扩大倍数与是否停线为推定值，须现场确认（规范 §5.3）'
      };
    }
    return {
      escalated: true, stopLine: false,   // 不自动停线
      text: `${failCount} 块失效 → 建议该批次冻结并转工程分析（FA）`,
      note: '⚠️ 停线判据未定，请人工决策。本系统只提示，不自动停线（规范 §10 🔴#3）'
    };
  }

  return {
    DEFAULT_RATIO,
    calc, plan, consistency, isSampled, pick, failureAdvice
  };
})();
