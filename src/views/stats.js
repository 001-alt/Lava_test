/* ============================================================================
   产量统计 —— 产能对比、占用、瓶颈分析、ORT 自洽性互验
   ============================================================================ */

const ViewStats = (() => {

  async function render() {
    await App.ensureRecords('records');
    const cfg = App.cfg;
    const ov = Capacity.overview(cfg);
    const topo = Topology.all(cfg);
    const bn = ov.bottleneck;

    /* 各工站实际占用 */
    const occupancy = ov.rows.map(r => {
      const eqs = topo.stationsMap[r.station] || [];
      const c = SlotGrid.countStates(eqs, App.slots);
      return { station: r.station, name: r.name, color: r.color, online: r.online,
               used: c.used, testing: c.testing, pass: c.pass, fail: c.fail,
               abort: c.abort, util: c.util, c };
    });
    const totalOnline = occupancy.reduce((a, x) => a + x.online, 0);
    const totalUsed = occupancy.reduce((a, x) => a + x.used, 0);

    /* 近 7 日产量趋势 */
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = Util.todayKey(d);
      const n = (App.records || []).filter(r => r.day === key &&
        String(r.result).toUpperCase() === 'PASS').length;
      days.push({ label: key.slice(5), value: n });
    }

    /* ORT 自洽性 */
    const con = Sampling.consistency(cfg);
    const ortPlan = Sampling.plan((App.workOrders || []).map(w => ({ id: w.id, no: w.no, qty: w.qty })));

    /* 当日良率 */
    const today = Util.todayKey();
    const todayRecs = (App.records || []).filter(r => r.day === today);
    const tp = todayRecs.filter(r => String(r.result).toUpperCase() === 'PASS').length;
    const tf = todayRecs.filter(r => String(r.result).toUpperCase() === 'FAIL').length;
    const ta = todayRecs.filter(r => String(r.result).toUpperCase() === 'ABORT').length;
    const y = Capacity.yieldOf({ pass: tp, fail: tf, abort: ta });

    Dom.html('statsBody',
      '<div class="cards">' +
        '<div class="card"><div class="lbl">全线同时在线容量</div>' +
          '<div class="val">' + Util.num(totalOnline) + '</div>' +
          '<div class="sub">7 道工序合计盘位</div></div>' +
        '<div class="card"><div class="lbl">当前在制</div>' +
          '<div class="val">' + Util.num(totalUsed) + '</div>' +
          '<div class="sub">整体利用率 ' + (totalOnline ? (totalUsed / totalOnline * 100).toFixed(1) : 0) + '%</div></div>' +
        '<div class="card accent"><div class="lbl">整线日产能（瓶颈）</div>' +
          '<div class="val">' + Util.num(Math.round(ov.lineRate)) + '</div>' +
          '<div class="sub">受 ' + (bn ? bn.name + ' · ' + bn.cn : '--') + ' 限制</div></div>' +
        '<div class="card"><div class="lbl">今日良率</div>' +
          '<div class="val" style="color:' + (y.pct == null ? 'var(--tx-3)' :
            y.pct >= 0.95 ? 'var(--ok)' : 'var(--warn)') + '">' +
            (y.pct == null ? '--' : (y.pct * 100).toFixed(2) + '%') + '</div>' +
          '<div class="sub">' + y.formula + '</div></div>' +
      '</div>' +

      Charts.barH(ov.rows.map(r => ({
        label: r.name, value: Math.round(r.daily), color: r.color,
        tag: r.isBottleneck ? ' <span class="badge b-fault">瓶颈</span>' :
             (r.bypass ? ' <span class="pill p-wait">旁路</span>' : '')
      })), {
        title: '各工序理论日产能 = 设备数 × 单台容量 × (1440 ÷ 单轮时长)',
        fmt: v => Util.num(v) + ' 块/天',
        note: '瓶颈决定整线节拍：<b>' + (bn ? bn.name + ' ' + Util.num(Math.round(bn.daily)) +
          ' 块/天' : '--') + '</b>。实际产能还需扣除换料、停机与复测。'
      }) +

      '<div style="height:14px"></div>' +

      Charts.barH(occupancy.map(x => ({
        label: x.name, value: Math.round(x.util * 100), color: x.color
      })), {
        title: '盘位占用率',
        fmt: (v, x) => v + '%',
        note: occupancy.map(x => x.name + ' ' + Util.num(x.used) + '/' + Util.num(x.online)).join(' · ')
      }) +

      '<div style="height:14px"></div>' +

      '<div class="section-title">瓶颈分析与优化建议</div>' +
      (Capacity.advice(cfg).map(a =>
        '<div class="suggest-card ' + (a.level === 'warn' ? 'warn' : a.level === 'bad' ? 'bad' : '') + '">' +
        a.text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + '</div>').join('') ||
        '<div class="empty-tip">暂无建议</div>') +

      '<div class="section-title">近 7 日通过量</div>' +
      Charts.barV(days, { title: '', note: '按测试记录的 PASS 条数统计' }) +

      '<div class="section-title">ORT 抽样容量互验' +
        '<span class="note-inline">数据自洽性检查</span></div>' +
      Charts.barH([
        { label: '主线需求（2.5%）', value: Math.round(con.demand), color: 'var(--st-ort)' },
        { label: 'ORT 能力', value: Math.round(con.capacity), color: 'var(--st-ort)' }
      ], {
        fmt: v => Util.num(v) + ' 块/天',
        note: '主线 ' + Util.num(Math.round(con.lineRate)) + ' 块/天 × 2.5% = ' +
          Util.num(Math.round(con.demand)) + ' 块/天；ORT ' + ST.ORT.count + ' 台 × ' +
          ST.ORT.capacity + ' 盘位 ÷ ' + (ST.ORT.cycleMin / 1440) + ' 天 = ' +
          Util.num(Math.round(con.capacity)) + ' 块/天。' +
          '<b style="color:' + (con.ok ? 'var(--ok)' : 'var(--warn)') + '">匹配度 ' +
          (con.match * 100).toFixed(1) + '%</b> —— ' +
          (con.ok ? '说明 ORT 的设备配置就是按 2.5% 抽检精确配的，也反证了 ORT 必须是旁路工序。'
                  : '与 2.5% 抽检需求偏差较大，建议核实 ORT 设备数或抽样比例。')
      }) +

      '<div class="section-title">工单 ORT 排轮测算</div>' +
      (ortPlan.list.length
        ? DataTable.build([
            { key: 'no', label: '工单号' },
            { key: 'qty', label: '批量', cls: 'num', fmt: v => Util.num(v) },
            { key: 'sample', label: '抽样量(2.5%)', cls: 'num' },
            { key: 'rounds', label: 'ORT 台次', cls: 'num' },
            { key: 'lastRoundLoad', label: '末轮装载', cls: 'num' },
            { key: 'desc', label: '说明' }
          ], ortPlan.list, { emptyText: '暂无工单' }) +
          '<div class="note">共需抽 <b>' + Util.num(ortPlan.totalSample) + '</b> 块 / <b>' +
          ortPlan.totalRounds + '</b> 台次；ORT 总容量 ' + Util.num(ortPlan.capacity) +
          ' 盘位，单轮 ' + ortPlan.cycleDays + ' 天。<br>' +
          '⚠️ 本表只做<b>测算与展示，不自动派工</b> —— 排轮逻辑与失效后的停线判据尚未经现场确认（规范 §10）。</div>'
        : '<div class="empty-tip">暂无工单</div>')
    );
  }

  function bind() { }

  return { render, bind };
})();
