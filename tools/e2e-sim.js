#!/usr/bin/env node
/* ============================================================================
   端到端演练（仿真日志）—— 不连任何产线设备
   ----------------------------------------------------------------------------
   验证整条链路真的通：

     导入真实台账 → 造仿真日志 → 桥接扫描 → 增量拉取 → 解析入库
       → **盘位状态更新** → 不良生成 → 幂等 → 追溯

   为什么必须有这个演练：
     每一段此前都用桩单独测过。但「拉完日志后看板该变」这件事，
     单元测试抓不到 —— 第一次跑就发现 pipeline 从不写 slots 表，
     平面图永远不动。这类缺口只有端到端才暴露。

   造两类日志：
     格式 A  键值对行式，通用解析器直接能吃
     格式 B  SSD 测试程序的表格输出，需专用解析器 ——
             同时验证「新增解析器只加一个文件，调用方不改」

   运行：node tools/e2e-sim.js
   ============================================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'Lava_test看板.html');
const BRIDGE = path.join(ROOT, 'bridge', 'lava_bridge.py');
const LEDGER = path.join(ROOT, '设备IP情况.xlsx');
const PORT = 8788;
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  [OK]   ' + m); }
  else { fail++; console.log('  [FAIL] ' + m + (extra ? '  -> ' + extra : '')); }
};
const head = t => console.log('\n' + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const s of ['stdout', 'stderr']) {
  try { process[s].reconfigure({ encoding: 'utf-8', errors: 'replace' }); } catch (e) { }
}

/* ==========================================================================
   DOM 桩
   ========================================================================== */
function mkEl() {
  const el = {
    innerHTML: '', textContent: '', value: '', files: null, dataset: {}, style: {},
    _cells: [], _byStation: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); }
    },
    setAttribute() { }, getAttribute() { return null; }, removeAttribute() { },
    appendChild(c) { return c; }, removeChild() { }, remove() { }, click() { }, focus() { },
    addEventListener() { }, removeEventListener() { },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    getContext() { return { scale() { }, clearRect() { }, fillRect() { }, fillStyle: '' }; },
    toBlob() { }, cloneNode() { return mkEl(); }
  };
  Object.defineProperty(el, 'className', {
    get() { return Array.from(el.classList._s).join(' '); },
    set(v) { el.classList._s = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  });
  return el;
}
const _els = {};
function installStubs() {
  global.window = {
    devicePixelRatio: 1, innerHeight: 900, pageYOffset: 0,
    addEventListener() { }, scrollTo() { }, requestAnimationFrame: cb => setTimeout(cb, 0),
    matchMedia: () => ({ matches: false, addEventListener() { }, addListener() { } })
  };
  Object.defineProperty(global, 'navigator', {
    value: { storage: null }, writable: true, configurable: true
  });
  global.document = {
    readyState: 'complete', body: mkEl(), documentElement: mkEl(),
    getElementById: id => _els[id] || (_els[id] = mkEl()),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => mkEl(), addEventListener() { }, removeEventListener() { }
  };
  global.localStorage = undefined;   // 走内存后端（最坏情况）
  global.indexedDB = undefined;
  global.IntersectionObserver = undefined;
  global.XMLSerializer = function () { this.serializeToString = () => ''; };
  global.Image = function () { };
  /* ⚠️ 只给 URL **挂方法**，别把全局 URL 换成普通对象 ——
     Node 内置 fetch（undici）依赖真实的 URL 类，
     整体替换会让所有 fetch 抛 "fetch failed"，
     表现成「桥接服务不可达」，极难定位。 */
  if (typeof global.URL === 'function') {
    global.URL.createObjectURL = () => 'blob:x';
    global.URL.revokeObjectURL = () => { };
  } else {
    global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() { } };
  }
  global.FileReader = function () { };
  global.requestAnimationFrame = cb => setTimeout(cb, 0);
  // 不要覆盖 fetch —— 这里打真实的桥接 HTTP
}

/* ==========================================================================
   造仿真日志（引用真实台账里的设备）
   ========================================================================== */
function makeFixtures(dir, devices) {
  fs.mkdirSync(dir, { recursive: true });

  /* 挑真实设备来造日志 —— 这样解析出的位置能对上拓扑，盘位才会被写入 */
  const servStations = ['FUNCTION', 'FINAL', 'ORT', 'CUS'];
  const servDev = devices.filter(d => servStations.indexOf(d.station) >= 0 && d.ip);
  const boxDev = devices.filter(d => (d.station === 'BIST' || d.station === 'ESS') && d.ip);

  const pickServ = servDev.slice(0, 1)[0] || null;
  const pickBox = boxDev.slice(0, 1)[0] || null;

  const files = [];
  let expectA = 0, expectB = 0;

  /* ---- 格式 A：键值对行式（带 IP，让台账反查能定位设备）---- */
  if (pickServ) {
    const lines = [
      '# Lava_test 仿真日志 A —— 键值对行式',
      '# 用途：验证通用解析器（registry 内置 generic-line）',
      '# 设备：' + pickServ.id + '  IP：' + pickServ.ip,
      ''
    ];
    for (let i = 1; i <= 12; i++) {
      const sn = 'LVA260929-' + String(i).padStart(5, '0');
      const r = i % 7 === 0 ? 'FAIL' : 'PASS';
      lines.push(`2026-09-29 08:${String(10 + i).padStart(2, '0')}:00  ` +
        `SN: ${sn}  Station: ${pickServ.station}  Slot: ${i}  ` +
        `IP: ${pickServ.ip}  Result: ${r}`);
    }
    fs.writeFileSync(path.join(dir, 'A_' + pickServ.station + '_log.txt'), lines.join('\n'), 'utf8');
    files.push('A_' + pickServ.station + '_log.txt');
    expectA = 12;
  }

  /* ---- 格式 B：SSD 测试程序的表格输出（需专用解析器）---- */
  if (pickBox) {
    const lines = [
      '============================================================',
      '  Lava SLT Test Log',
      '  Station    : ' + pickBox.station,
      '  Cabinet    : ' + (pickBox.cabinet || pickBox.zone || '-'),
      '  Equipment  : ' + pickBox.id,
      '  IP         : ' + pickBox.ip,
      '  Lot        : WO26092901',
      '  Start      : 2026-09-29 09:00:00',
      '------------------------------------------------------------',
      '  Slot | Position | Serial           | Result | Code',
      '------------------------------------------------------------'
    ];
    const n = 20;
    for (let i = 1; i <= n; i++) {
      const sn = 'LV260929B' + String(i).padStart(4, '0');
      const bad = i % 9 === 0;
      lines.push('  ' + String(i).padStart(4) + ' | ' +
        ('DIMM-' + (i % 16)).padEnd(8) + ' | ' +
        sn.padEnd(16) + ' | ' + (bad ? 'FAIL' : 'PASS').padEnd(6) + ' | ' +
        (bad ? 'E-BIST-407' : '-'));
    }
    lines.push('------------------------------------------------------------');
    lines.push('  Total ' + n + '  Passed ' + (n - 2) + '  Failed 2');
    lines.push('  End        : 2026-09-29 09:42:11');
    lines.push('============================================================');
    fs.writeFileSync(path.join(dir, 'B_' + pickBox.station + '_' + pickBox.id + '_log.txt'),
      lines.join('\n'), 'utf8');
    files.push('B_' + pickBox.station + '_' + pickBox.id + '_log.txt');
    expectB = n;
  }

  /* 不该被拉的文件 */
  fs.writeFileSync(path.join(dir, 'readme.md'), '# 不是日志', 'utf8');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '普通笔记，没有 SN 信息。', 'utf8');
  files.push('readme.md', 'notes.txt');

  return { files, expectA, expectB, pickServ, pickBox };
}

/* ==========================================================================
   工具
   ========================================================================== */
function waitPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) reject(new Error('桥接启动超时'));
        else setTimeout(tick, 250);
      });
    })();
  });
}

/* ==========================================================================
   主流程
   ========================================================================== */
(async function main() {
  if (!fs.existsSync(HTML)) { console.log('❌ 未找到构建产物，请先 node build.js'); process.exit(1); }
  if (!fs.existsSync(LEDGER)) { console.log('❌ 未找到 设备IP情况.xlsx'); process.exit(1); }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lava-e2e-'));

  console.log('='.repeat(68));
  console.log(' Lava_test 端到端演练（仿真日志，不连产线设备）');
  console.log('='.repeat(68));

  head('0. 启动桥接服务');
  const proc = spawn(process.env.PYTHON || 'python',
    [BRIDGE, '--port', String(PORT), '--web-root', ROOT],
    { cwd: path.join(ROOT, 'bridge'), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => { });
  proc.stderr.on('data', () => { });

  try {
    await waitPort(PORT, 15000);
    ok(true, '桥接已监听 ' + PORT);

    head('1. 加载前端并导入真实设备台账');
    installStubs();
    const src = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
    eval(src + '\nglobal.__A={App,Repo,Bridge,FtpChannel,Pipeline,ParserRegistry,' +
      'Topology,Schema,Util,Registry,Ledger,Xlsx,Highlight,Bus,EVT,' +
      'Trace,DefectEngine,Capacity,Sampling,WorkOrder,MatchEngine,Backup,SlotGrid};');
    const A = global.__A;
    const { App, Repo, Bridge, FtpChannel, Pipeline, ParserRegistry,
            Topology, Util, Registry, Ledger, Xlsx } = A;

    await App.boot();
    ok(true, 'App.boot() 完成（存储后端 ' + Repo.backend() + '）');

    const buf = fs.readFileSync(LEDGER);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const wb = await Xlsx.parse(ab);
    const parsed = Ledger.parse(wb.sheets[0]);
    const reg = Registry.fromLedger(parsed);
    await App.saveDevices(reg.devices);
    Topology.setRegistry(App.devices);
    await App.loadAll();
    ok(App.devices.length > 400, '导入设备台账 ' + App.devices.length + ' 台');
    const topo = Topology.all(App.cfg);
    ok(topo.source.indexOf('registry') === 0,
       '拓扑切到台账模式（' + topo.source + '），盘位 ' + topo.totalSlots.toLocaleString());

    head('2. 造仿真日志（引用真实设备，格式 A 定位到设备）');
    const fx = makeFixtures(path.join(work, 'logs'), App.devices);
    const logDir = path.join(work, 'logs');
    console.log('     日志目录 : ' + logDir);
    console.log('     仿真文件 : ' + fx.files.join(' / '));
    ok(!!fx.pickServ, '格式 A 锚定设备 ' + (fx.pickServ ? fx.pickServ.id + '@' + fx.pickServ.ip : '-'));
    ok(!!fx.pickBox, '格式 B 锚定设备 ' + (fx.pickBox ? fx.pickBox.id + '@' + fx.pickBox.ip : '-'));

    App.cfg.channels.ftp.bridgeUrl = BASE;
    App.cfg.channels.localDir.path = logDir;
    App.cfg.settings.onlyNew = true;
    App.cfg.settings.maxFilesPerRun = 50;
    App.cfg.scanRoots = [{ id: 'r_logs', name: '仿真日志', path: logDir,
                           kind: 'log', enabled: true, station: '' }];
    ok((await Bridge.pushConfig()).ok, '配置已下发到桥接');

    head('3. 扫描 → 拉取');
    const scanRes = await FtpChannel.scanAllRoots('local');
    ok(scanRes.errors.length === 0, '扫描无错误', JSON.stringify(scanRes.errors));
    ok(scanRes.files.length >= 2, '扫描到 ' + scanRes.files.length + ' 个文件');

    const st1 = await FtpChannel.pull('local', { files: scanRes.files, onlyNew: true });
    ok(!!st1 && st1.failed === 0, '拉取 ' + (st1 ? st1.pulled : 0) +
       ' 个文件（' + (st1 ? Util.bytes(st1.bytes) : '-') + '），无失败');
    const raw = await Repo.query('rawfiles', null, { limit: 100 });
    ok(raw.length >= 2, '原始日志留档 ' + raw.length + ' 份（格式明确后可离线重解析）');

    head('4. 解析结果');
    await App.ensureRecords('records');
    let recs = App.records || [];
    const fromA = recs.filter(r => /^LVA260929-/.test(r.sn));
    const fromB = recs.filter(r => /^LV260929B/.test(r.sn));
    console.log('     格式 A（键值对行式）：' + fromA.length + ' 条（期望 ' + fx.expectA + '）');
    console.log('     格式 B（SSD 程序风格）：' + fromB.length + ' 条（期望 ' + fx.expectB + '）');
    ok(fromA.length === fx.expectA, '格式 A 被通用解析器完整解析');
    ok(fromB.length === 0, '格式 B 未被通用解析器误解析（没有脏数据）');

    head('5. ★ 盘位是否被更新（本次演练的核心）');
    const servRecs = fromA.filter(r => r.equipmentId && r.slotIndex != null);
    console.log('     格式 A 中带位置信息的记录：' + servRecs.length + ' 条');
    if (servRecs.length) {
      const s = servRecs[0];
      console.log('       样例：' + s.sn + ' → 设备 ' + s.equipmentId +
                  ' 位号 ' + (s.slotIndex + 1) + '（由 IP ' + fx.pickServ.ip + ' 经台账反查）');
    }
    ok(servRecs.length > 0, 'IP 经设备台账反查到设备编号并定位到盘位');

    const slotHit = servRecs.filter(r => {
      const eq = (topo.stationsMap[r.station] || []).filter(e => e.id === r.equipmentId)[0];
      if (!eq) return false;
      const rec = App.slots.get(eq.slotKeys[r.slotIndex]);
      return rec && rec.sn === r.sn;
    });
    ok(slotHit.length === servRecs.length,
       '解析结果已写入盘位表（' + slotHit.length + '/' + servRecs.length + '）',
       '未写入的盘位说明 pipeline → slots 这一步断了');

    if (slotHit.length) {
      const r0 = slotHit[0];
      const eq0 = (topo.stationsMap[r0.station] || []).filter(e => e.id === r0.equipmentId)[0];
      const cell = App.slots.get(eq0.slotKeys[r0.slotIndex]);
      console.log('       盘位 ' + cell.key + '：状态 ' + cell.state +
                  ' / SN ' + cell.sn + ' / 结果 ' + cell.result);
      ok(cell.state === 'pass' || cell.state === 'fail',
         '盘位状态由结果映射而来（' + cell.state + '）');
      ok(!!cell.endTime, '盘位带结束时间（用于平面图显示剩余时长）');
    }

    head('6. 不良记录');
    App.invalidate('bad');
    await App.ensureRecords('bad');
    const bads = App.bad || [];
    const failRecs = recs.filter(r => r.result === 'FAIL');
    ok(failRecs.length > 0, '记录里有 ' + failRecs.length + ' 条 FAIL');
    ok(bads.length >= failRecs.length, 'FAIL 都走了判定引擎（' + bads.length + ' 条不良）');

    head('7. 幂等');
    const before = (App.records || []).length;
    const st2 = await FtpChannel.pull('local', { files: scanRes.files, onlyNew: true });
    ok(st2.pulled === 0, '增量模式：第二轮未重复下载');
    const st3 = await FtpChannel.pull('local', { files: scanRes.files, onlyNew: false });
    App.invalidate('records');
    await App.ensureRecords('records');
    ok(st3.pulled > 0, '全量模式确实重新下载了 ' + st3.pulled + ' 个');
    ok((App.records || []).length === before,
       '幂等键拦住重复入库（' + before + ' → ' + (App.records || []).length + '）');

    /* 「无变化不改动」要直接测 applyToSlots ——
       去重发生在它之前，重复记录根本到不了这一步，走完整流程测不到。 */
    const sameRecs = (App.records || []).filter(r => r.equipmentId && r.slotIndex != null);
    const slotStats = await Pipeline.applyToSlots(sameRecs);
    ok(slotStats.unchanged === sameRecs.length && slotStats.applied === 0,
       '同一批记录再应用一次：全部判定为「无变化」（' +
       slotStats.unchanged + '/' + sameRecs.length + ' 跳过，写入 ' + slotStats.applied + '）');

    head('8. 注册专用解析器（验证扩展点，调用方不改）');
    const beforeP = ParserRegistry.all().length;
    ParserRegistry.register({
      id: 'lava-slt-table',
      name: 'Lava SLT 表格式',
      desc: 'SSD 测试程序的表格输出（Slot | Position | Serial | Result | Code）',
      priority: 10,
      match: ctx => /Lava SLT Test Log|Slot\s*\|\s*Position/i.test(ctx.head || ''),
      parse: (text, ctx) => {
        const out = [];
        const g = (re) => { const m = re.exec(text); return m ? m[1].trim() : ''; };
        const station = g(/Station\s*:\s*(\w+)/i);
        const equip = g(/Equipment\s*:\s*(\S+)/i);
        const ip = g(/IP\s*:\s*([\d.]+)/i);
        const wo = g(/Lot\s*:\s*(\S+)/i);
        text.split(/\r?\n/).forEach((line, i) => {
          const m = /^\s*(\d+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(PASS|FAIL)\s*\|\s*(\S+)/i.exec(line);
          if (!m) return;
          out.push({
            sn: m[3],
            slotIndex: Number(m[1]) - 1,
            station, equipmentId: equip, ip, woNo: wo,
            result: m[4].toLowerCase(),
            errCode: m[5] === '-' ? '' : m[5],
            lineNo: i + 1,
            rawText: line.trim().slice(0, 200)
          });
        });
        return out;
      }
    });
    ok(ParserRegistry.all().length === beforeP + 1, '解析器已注册（' + beforeP + ' → ' +
       ParserRegistry.all().length + '）');

    await Repo.clearTable('records');
    await Repo.clearTable('ledger');
    App.invalidate();
    await App.loadAll();
    await App.ensureRecords('records');
    await FtpChannel.pull('local', { files: scanRes.files, onlyNew: false });
    App.invalidate('records');
    await App.ensureRecords('records');
    recs = App.records || [];
    const fromB2 = recs.filter(r => /^LV260929B/.test(r.sn));
    console.log('     格式 B 抽到 ' + fromB2.length + ' 条（期望 ' + fx.expectB + '）');
    ok(fromB2.length === fx.expectB, '格式 B 被专用解析器完整解析');

    const bSlotHit = fromB2.filter(r => {
      const eq = (Topology.all(App.cfg).stationsMap[r.station] || [])
        .filter(e => e.id === r.equipmentId)[0];
      if (!eq || r.slotIndex == null) return false;
      const cell = App.slots.get(eq.slotKeys[r.slotIndex]);
      return cell && cell.sn === r.sn;
    });
    ok(bSlotHit.length === fx.expectB,
       '格式 B 的记录也写入了盘位（' + bSlotHit.length + '/' + fx.expectB + '）');

    const failB = fromB2.filter(r => r.result === 'FAIL');
    ok(failB.length === 2 && failB.every(r => r.errCode === 'E-BIST-407'),
       'FAIL 与错误码正确提取（' + failB.length + ' 条）');

    head('9. 判定引擎在真实解析结果上工作');
    App.invalidate('bad');
    await App.ensureRecords('bad');
    const b407 = (App.bad || []).filter(b => b.errCode === 'E-BIST-407');
    ok(b407.length >= 2, 'E-BIST-407 生成了不良记录 ' + b407.length + ' 条');
    if (b407.length) {
      ok(b407[0].verdict === 'functional', '按规则表判为功能性不良');
      ok(b407[0].confirmed === true, '功能性不良自动确认');
    }

    head('10. 幂等（新解析器下）');
    const n1 = (App.records || []).length;
    await FtpChannel.pull('local', { files: scanRes.files, onlyNew: false });
    App.invalidate('records');
    await App.ensureRecords('records');
    ok((App.records || []).length === n1,
       '再次全量拉取记录数不变（' + n1 + '）');

    head('11. 追溯');
    const sn0 = fromB2[0] && fromB2[0].sn;
    if (sn0) {
      const chain = A.Trace.bySn(sn0, App.records || []);
      ok(chain.chain.length === 7, '单块流转链含 7 段（6 主线 + ORT）');
      const seg = chain.chain.filter(c => c.station === fx.pickBox.station)[0];
      ok(seg && seg.state !== 'pending',
         fx.pickBox.station + ' 段已有记录（' + (seg ? seg.state : '-') + '）');
      ok(!!chain.pn || !!chain.woNo, '关联到工单 ' + (chain.woNo || '-'));
    }

    head('12. 看板视图能否渲染出来');
    try {
      await App.switchView('floor');
      const html = document.getElementById('floorBody').innerHTML;
      ok(html.length > 1000, '平面图渲染 ' + (html.length / 1024).toFixed(0) + ' KB');
      const withSn = (html.match(/class="cell s-(pass|fail)/g) || []).length;
      ok(withSn > 0, '平面图上出现 ' + withSn + ' 个有结果的盘位格');
      await App.switchView('daily');
      ok(document.getElementById('dailyBody').innerHTML.length > 500, '当日报表可渲染');
      await App.switchView('trace');
      ok(document.getElementById('traceBody').innerHTML.length > 200, '追溯页可渲染');
    } catch (e) {
      ok(false, '视图渲染抛错', e.message);
    }

  } catch (e) {
    ok(false, '演练抛错：' + e.message);
    console.log('     ' + (e.stack || '').split('\n').slice(1, 4).join('\n     '));
  } finally {
    try { await fetch(BASE + '/api/shutdown', { method: 'POST' }); } catch (e) { }
    await sleep(400);
    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { }
  }

  console.log('\n' + '='.repeat(68));
  console.log(`端到端演练：${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(68) + '\n');
  process.exit(fail ? 1 : 0);
})();
