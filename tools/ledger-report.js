#!/usr/bin/env node
/* ============================================================================
   台账解析报告 —— 用真实 xlsx 验证 Xlsx + Ledger 两个模块
   运行：node tools/ledger-report.js [文件路径]
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const Xlsx = require('../src/ingest/parsers/xlsx.js');
const Ledger = require('../src/ingest/ledger.js');

const FILE = process.argv[2] || path.join(__dirname, '..', '设备IP情况.xlsx');

(async () => {
  const buf = fs.readFileSync(FILE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const wb = await Xlsx.parse(ab);
  const sheet = wb.sheets[0];
  console.log('文件：' + path.basename(FILE));
  console.log('工作表：' + wb.sheets.map(s => s.name || '(未命名)').join(' / ') +
              '，解析 ' + sheet.rows.length + ' 行');

  const p = Ledger.parse(sheet);
  console.log('表头行：r' + p.headerRow);
  console.log('识别到的列：' + JSON.stringify(p.columns));

  console.log('\n' + '='.repeat(72));
  console.log('汇总区（台账里人工维护的数字）');
  console.log('='.repeat(72));
  console.log('工站        设备数  在制槽位  4.0.0  4.2.0  备注');
  p.summary.forEach(s => {
    if (!s.station) { console.log('  备注：' + s.note); return; }
    console.log(s.station.padEnd(11) +
      String(s.deviceCount == null ? '-' : s.deviceCount).padStart(6) +
      String(s.slotCount == null ? '-' : s.slotCount).padStart(9) +
      String(s.v400 == null ? '-' : s.v400).padStart(7) +
      String(s.v420 == null ? '-' : s.v420).padStart(7) + '  ' + (s.note || ''));
  });

  console.log('\n' + '='.repeat(72));
  console.log('明细区统计（逐行解析出来的）');
  console.log('='.repeat(72));
  console.log('明细行 ' + p.stats.totalRows + ' 行：可接入 ' + p.stats.activeCount +
              ' 台，跳过 ' + p.stats.skippedCount + ' 台（借用/无设备/无 IP）');
  console.log('去重 IP ' + p.stats.ipCount + ' 个，机柜 ' + p.stats.cabinetCount + ' 个');

  console.log('\n工站        设备数   去重IP  机柜数  主要型号');
  Object.keys(p.stats.byStation).sort().forEach(k => {
    const v = p.stats.byStation[k];
    const topModel = Object.keys(v.models).sort((a, b) => v.models[b] - v.models[a])[0] || '-';
    console.log(k.padEnd(11) + String(v.count).padStart(6) + String(v.ips.size).padStart(8) +
      String(v.cabinets.size).padStart(7) + '  ' + topModel.slice(0, 30));
  });

  console.log('\n' + '='.repeat(72));
  console.log('机柜清单（' + p.stats.cabinetCount + ' 个）');
  console.log('='.repeat(72));
  const cabs = Object.keys(p.stats.byCabinet).sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ''), 10) || 0;
    return na - nb;
  });
  cabs.forEach(c => {
    const v = p.stats.byCabinet[c];
    const st = Object.keys(v.stations).map(k => k + '×' + v.stations[k]).join(' ');
    console.log('  ' + c.padEnd(10) + String(v.count).padStart(3) + ' 台   ' + st);
  });

  console.log('\n' + '='.repeat(72));
  console.log('与看板当前配置的对比');
  console.log('='.repeat(72));
  /* 从 constants.js 取工站基线配置（不启动整个 App）。
     用 Function 构造器而不是 eval：符号留在自己的作用域里，不污染本脚本。 */
  const constSrc = fs.readFileSync(path.join(__dirname, '..', 'src/core/constants.js'), 'utf8');
  const STATIONS = new Function(constSrc + '\nreturn STATIONS;')();
  const d = Ledger.diff(STATIONS, p);

  console.log('工站        看板配置   台账明细   台账汇总声明    差异(明细)  差异(声明)');
  d.forEach(x => {
    const f = (n) => n === 0 ? '一致' : (n > 0 ? '+' + n : String(n));
    const mark = (x.diff === 0 && (x.diffDeclared === 0 || x.diffDeclared == null)) ? '' : '  ⚠️';
    console.log(x.name.padEnd(11) + String(x.configured).padStart(8) +
      String(x.ledger).padStart(11) +
      String(x.declared == null ? '-' : x.declared).padStart(13) +
      '   ' + f(x.diff).padStart(10) +
      '   ' + (x.diffDeclared == null ? '-' : f(x.diffDeclared)).padStart(10) + mark);
  });

  if (p.warnings.length) {
    console.log('\n' + '='.repeat(72));
    console.log('警告');
    console.log('='.repeat(72));
    p.warnings.forEach(w => console.log('  ⚠️  ' + w));
    if (p.stats.dupIps.length) {
      p.stats.dupIps.slice(0, 10).forEach(x =>
        console.log('     重复 IP ' + x.ip + '（r' + x.rows.join(' 与 r') + '）'));
    }
  }

  console.log('\n--- 设备抽样（前 8 / 后 5） ---');
  p.active.slice(0, 8).concat(p.active.slice(-5)).forEach(x => {
    console.log('  r' + String(x.row).padStart(4) + ' | ' + (x.cabinet || '-').padEnd(8) +
      ' | ' + (x.station || '?').padEnd(9) + ' | ' + (x.ip || '-').padEnd(16) +
      ' | ' + (x.ipAlt || '-').padEnd(16) + ' | ' + (x.model || '').slice(0, 24));
  });
})().catch(e => { console.error('❌ ' + e.message); console.error(e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); });
