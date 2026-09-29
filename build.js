#!/usr/bin/env node
/* ============================================================================
   Lava_test 看板 · 构建脚本
   ----------------------------------------------------------------------------
   把 src/ 下的多模块源码合并成一个单文件 HTML：

       src/index.html   含两个注入锚点：
         <!-- @@STYLES@@ -->    ← 替换为 src/styles/*.css 顺序拼接
         <!-- @@SCRIPTS@@ -->   ← 替换为 src/scripts.list 里列出的 js 顺序拼接

   产物：Lava_test看板.html（双击即用，无需服务器）

   为什么用「普通脚本拼接」而不是 ES Module：
     ES Module 在 file:// 协议下会被 CORS 拦截，双击打不开。
     拼接成单个内联 <script> 后所有模块共享全局作用域，file:// 可用。

   用法：
     node build.js            构建
     node build.js --check    构建后做语法检查
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'Lava_test看板.html');

/* 模块加载顺序 —— 顺序即依赖顺序，后加载的可引用先加载的。
   新增模块时在这里登记，不要依赖文件名字典序。 */
const SCRIPTS = [
  'core/constants.js',
  'core/util.js',
  'core/eventbus.js',
  'core/dom.js',
  'core/i18n.js',
  'core/theme.js',

  'store/schema.js',
  'store/localstore.js',
  'store/idb.js',
  'store/migrate.js',
  'store/repository.js',
  'store/backup.js',

  'domain/topology.js',
  'domain/registry.js',
  'domain/capacity.js',
  'domain/sampling.js',
  'domain/errcode-rules.js',
  'domain/defect-engine.js',
  'domain/match-engine.js',
  'domain/workorder.js',
  'domain/trace.js',

  // —— 设备台账（xlsx 导入）——
  'ingest/parsers/xlsx.js',      // 零依赖 xlsx 解析
  'ingest/ledger.js',            // 台账解释器
  // —— 日志解析与入库 ——
  'ingest/registry.js',          // 解析器注册表（新增格式只加文件，不改调用方）
  'ingest/pipeline.js',          // 解析 → 归一 → 幂等去重 → 落库 → 判定

  // —— 桥接客户端（页面与 Python 桥接服务之间）——
  'bridge/client.js',            // HTTP 封装 / 错误归一 / 健康检查
  'bridge/ssh.js',               // SSH 巡检结果落到看板
  'bridge/ftp.js',               // FTP / 本地目录 扫描与增量拉取
  'bridge/scheduler.js',         // 节拍调度（不可见跳过 + busy 自锁）

  'components/toast.js',
  'components/modal.js',
  'components/drawer.js',
  'components/table.js',
  'components/slot-grid.js',
  'components/virtual-list.js',
  'components/charts.js',
  'components/timeline.js',
  'components/highlight.js',

  'views/floor.js',
  'views/board.js',
  'views/stats.js',
  'views/daily.js',
  'views/bad.js',
  'views/error.js',
  'views/pull.js',
  'views/wo.js',
  'views/log.js',
  'views/trace.js',

  'modals/index.js',
  'modals/ledger.js',

  'dev/mock.js',          // 开发工具：模拟数据生成器

  'main.js'
];

const CSS_ORDER = [
  'styles/base.css',
  'styles/board.css',
  'styles/tables.css',
  'styles/modals.css'
];

/* ---------------- 工具 ---------------- */
function fail(msg) {
  console.error('\n[构建失败] ' + msg + '\n');
  process.exit(1);
}
function read(rel) {
  const p = path.join(SRC, rel);
  if (!fs.existsSync(p)) fail('找不到模块：src/' + rel + '\n    如果是新增模块，请在 build.js 的 SCRIPTS 里登记。');
  return fs.readFileSync(p, 'utf8');
}
function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

/* ---------------- 1. 读模板 ---------------- */
if (!fs.existsSync(SRC)) fail('找不到 src/ 目录');
const tplPath = path.join(SRC, 'index.html');
if (!fs.existsSync(tplPath)) fail('找不到 src/index.html');
let html = fs.readFileSync(tplPath, 'utf8');

if (html.indexOf('<!-- @@STYLES@@ -->') < 0) fail('src/index.html 缺少 <!-- @@STYLES@@ --> 锚点');
if (html.indexOf('<!-- @@SCRIPTS@@ -->') < 0) fail('src/index.html 缺少 <!-- @@SCRIPTS@@ --> 锚点');

/* ---------------- 2. 合并 CSS ---------------- */
const cssParts = [];
let cssLines = 0;
CSS_ORDER.forEach(rel => {
  const t = read(rel);
  cssLines += t.split('\n').length;
  cssParts.push(`/* ===== src/${rel} ===== */\n${t}`);
});
const css = cssParts.join('\n\n');

/* ---------------- 3. 合并 JS ---------------- */
const jsParts = [];
let jsLines = 0;
const missing = [];
SCRIPTS.forEach(rel => {
  const p = path.join(SRC, rel);
  if (!fs.existsSync(p)) { missing.push(rel); return; }   // 允许阶段间逐步补齐
  const t = fs.readFileSync(p, 'utf8');
  jsLines += t.split('\n').length;
  jsParts.push(`/* ${'='.repeat(74)}\n   src/${rel}\n   ${'='.repeat(74)} */\n${t}`);
});
if (missing.length) {
  console.warn('[提示] 以下模块尚未创建，已跳过（' + missing.length + ' 个）：');
  missing.forEach(m => console.warn('       src/' + m));
}
const js = jsParts.join('\n\n');

/* ---------------- 4. 注入 ---------------- */
const banner =
  `<!--\n  Lava_test 固态硬盘全段测试看板\n` +
  `  构建时间：${new Date().toLocaleString('zh-CN')}\n` +
  `  构建来源：src/ 多模块合并（请勿直接改本文件，改 src/ 后跑 node build.js）\n` +
  `  模块数：${SCRIPTS.length - missing.length} 个 JS / ${CSS_ORDER.length} 个 CSS\n` +
  `-->\n`;

/* ⚠️ 必须用「函数」作为替换值，不能用字符串。
   String.replace 在替换值是字符串时会解释 $ 序列：
     $&  插入匹配到的子串
     $`  插入匹配位置之前的文本
     $'  插入匹配位置之后的文本   ← 致命
     $n  插入第 n 个捕获组
   源码里出现 '...' + '$' 或正则字面量 '...$' 时（如 match-engine.js 的
   '^(ICT|在线电路)$'、util.js 的 '﻿' 拼接）就会被静默破坏，
   表现为构建产物语法错误、内容里混入 </body></html>。
   传函数则完全绕开这套替换语义。 */
html = html.replace('<!-- @@STYLES@@ -->', () => '<style>\n' + css + '\n</style>');
html = html.replace('<!-- @@SCRIPTS@@ -->', () => '<script>\n' + js + '\n</script>');
html = html.replace('<head>', () => '<head>\n' + banner);

fs.writeFileSync(OUT, html, 'utf8');

/* ---------------- 5. 汇总 ---------------- */
const outBytes = Buffer.byteLength(html, 'utf8');
console.log('\n=== Lava_test 构建完成 ===');
console.log('  输出      : Lava_test看板.html  (' + kb(outBytes) + ')');
console.log('  CSS       : ' + CSS_ORDER.length + ' 个 / ' + cssLines + ' 行');
console.log('  JS        : ' + (SCRIPTS.length - missing.length) + ' 个 / ' + jsLines + ' 行');
if (missing.length) console.log('  未创建    : ' + missing.length + ' 个（见上方提示）');
console.log('  下一步    : 双击 Lava_test看板.html 验收\n');

/* ---------------- 6. 可选语法检查 ----------------
   ⚠️ 必须校验**注入后**的产物，而不是注入前的 js 字符串。
   注入本身可能破坏源码（见上面 replace 的 $ 陷阱），
   只检查注入前的 js 会漏掉这类错误。 */
if (process.argv.includes('--check')) {
  const tmp = path.join(ROOT, '_syntax_check.js');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) {
    console.error('  ✗ 产物里找不到 <script> 块，注入可能失败\n');
    process.exit(1);
  }
  const injected = m[1];
  fs.writeFileSync(tmp, injected, 'utf8');

  let bad = false;
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    bad = true;
    console.error('  ✗ 产物 JS 语法检查失败：\n' + (e.stderr || e.message).toString());
  }
  fs.unlinkSync(tmp);

  // 额外校验：产物里不该出现 HTML 结束标签混入脚本
  if (/<\/body>|<\/html>/.test(injected)) {
    bad = true;
    console.error('  ✗ 产物脚本里混入了 </body> 或 </html> —— 典型的 replace 替换陷阱\n');
  }
  // 注入模板是 '<script>\n' + js + '\n</script>'，故提取内容 = '\n' + js + '\n'
  const expected = '\n' + js + '\n';
  if (injected !== expected) {
    bad = true;
    // 定位第一处差异，直接指出被破坏的位置，省去人工比对
    let i = 0;
    while (i < Math.min(injected.length, expected.length) && injected[i] === expected[i]) i++;
    const ctx = expected.slice(Math.max(0, i - 40), i + 40).replace(/\n/g, '⏎');
    console.error('  ✗ 注入过程改动了内容，首个差异在第 ' + i + ' 字符附近：');
    console.error('      ' + ctx + '\n');
  }
  if (!bad) console.log('  ✓ 产物 JS 语法检查通过（注入后 ' + injected.length + ' 字符）\n');
  else process.exit(1);
}
