/* ============================================================================
   通用工具 —— 纯函数，无 DOM 副作用（下载/剪贴板除外，它们只在导出时调用）
   ============================================================================ */

const Util = (() => {

  /* ---------- 随机 / 标识 ---------- */
  let _seq = 0;
  function uid(prefix) {
    _seq++;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
           _seq.toString(36) + Math.random().toString(36).slice(2, 5);
  }
  /* 32 位字符串哈希（用于确定性生成，如按 SN 推抽样命中） */
  function hash(str) {
    let h = 0;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }
  function hashCode(str) { return Math.abs(hash(str)); }

  /* 确定性伪随机（同一 seed 永远产出同一序列）—— 模拟数据可复现 */
  function seededRandom(seed) {
    let s = (seed | 0) || 1;
    return function () {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  /* ---------- 填空 / 补零 ---------- */
  function pad(n, w) { return String(n).padStart(w || 2, '0'); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* ---------- 时间 ---------- */
  function nowStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function todayKey(d) {
    const t = d || new Date();
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }
  /* 时间戳 → 'MM-DD HH:mm' */
  function fmtTime(ts) {
    if (!ts) return '--';
    const d = (ts instanceof Date) ? ts : new Date(ts);
    if (isNaN(d.getTime())) return '--';
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  /* 时间戳 → 'YYYY-MM-DD HH:mm:ss' */
  function fmtFull(ts) {
    if (!ts) return '--';
    const d = (ts instanceof Date) ? ts : new Date(ts);
    if (isNaN(d.getTime())) return '--';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  /* 毫秒时长 → 人类可读。跨 5 个数量级（6 秒 ～ 7 天），必须分段 */
  function fmtDur(ms) {
    if (ms == null || isNaN(ms)) return '--';
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}天 ${pad(h)}h`;
    if (h > 0) return `${h}h ${pad(m)}m`;
    if (m > 0) return `${m}m ${pad(s % 60)}s`;
    return `${s}s`;
  }
  /* 单轮时长（分钟）→ 人类可读。ICT 是 0.1 分钟，必须显示秒 */
  function fmtCycle(min) {
    if (min == null) return '--';
    if (min < 1)    return Math.round(min * 60) + ' 秒';
    if (min < 60)   return min + ' 分钟';
    if (min < 1440) return (min / 60).toFixed(min % 60 ? 1 : 0) + ' 小时';
    return (min / 1440).toFixed(min % 1440 ? 1 : 0) + ' 天';
  }
  /* 数据新鲜度：距今多久 */
  function freshness(ts) {
    if (!ts) return { level: 'none', text: '无数据', sec: null };
    const sec = Math.floor((Date.now() - Number(ts)) / 1000);
    if (sec < 0) return { level: 'live', text: '刚刚', sec: 0 };
    if (sec < 120) return { level: 'live', text: sec + ' 秒前', sec };
    if (sec < 3600) return { level: 'live', text: Math.floor(sec / 60) + ' 分钟前', sec };
    if (sec < 86400) return { level: 'today', text: Math.floor(sec / 3600) + ' 小时前', sec };
    return { level: 'stale', text: Math.floor(sec / 86400) + ' 天前', sec };
  }
  /* 导出文件名的统一时间戳 YYYYMMDD_HHMM */
  function tsTag() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  /* ---------- 转义 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  /* 用于放进 title="..." 属性，换行转实体 */
  function escAttr(s) { return esc(s).replace(/\n/g, '&#10;'); }

  /* ---------- 数值 ---------- */
  function num(v, digits) {
    if (v == null || isNaN(v)) return '--';
    return Number(v).toLocaleString('zh-CN', digits != null
      ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : undefined);
  }
  function pct(v, digits) {
    if (v == null || isNaN(v)) return '--';
    return (v * 100).toFixed(digits == null ? 1 : digits) + '%';
  }
  function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
  function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

  /* 按 key 分组 */
  function groupBy(arr, fn) {
    const out = {};
    (arr || []).forEach(item => {
      const k = fn(item);
      (out[k] = out[k] || []).push(item);
    });
    return out;
  }
  /* 去重（按 key 函数） */
  function uniqBy(arr, fn) {
    const seen = new Set(), out = [];
    (arr || []).forEach(item => {
      const k = fn(item);
      if (seen.has(k)) return;
      seen.add(k); out.push(item);
    });
    return out;
  }

  /* ---------- 防抖 / 节流 ---------- */
  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }
  function throttle(fn, ms) {
    let last = 0, timer = null;
    return function (...args) {
      const now = Date.now();
      const remain = ms - (now - last);
      if (remain <= 0) { last = now; fn.apply(this, args); }
      else if (!timer) {
        timer = setTimeout(() => { last = Date.now(); timer = null; fn.apply(this, args); }, remain);
      }
    };
  }

  /* ---------- 深拷贝（状态快照用） ---------- */
  function clone(v) {
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    const o = {};
    for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = clone(v[k]);
    return o;
  }
  /* 浅层合并（只覆盖对象存在的一级键） */
  function assign(target, ...sources) {
    sources.forEach(s => { if (s) for (const k in s) if (s[k] !== undefined) target[k] = s[k]; });
    return target;
  }

  /* ---------- CSV ---------- */
  /* 字段转义：含逗号/引号/换行时加引号并把 " 变 "" */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /* headers 为 null 时只输出数据行（用于多段式文本报表） */
  function toCsv(headers, rows, opts) {
    const o = opts || {};
    const lines = [];
    if (headers && headers.length) lines.push(headers.map(csvCell).join(','));
    (rows || []).forEach(r => lines.push((Array.isArray(r) ? r : [r]).map(csvCell).join(',')));
    // Excel 打开中文 CSV 必须带 BOM，否则乱码
    const bom = (o.bom === false) ? '' : '﻿';
    return bom + lines.join(o.crlf === false ? '\n' : '\r\n');
  }

  /* ---------- 文本 ---------- */
  function truncate(s, n) {
    const t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  function basename(p) { return String(p || '').split(/[\\/]/).pop() || ''; }
  function extname(p) {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1).toLowerCase() : '';
  }
  function bytes(n) {
    if (n == null) return '--';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  /* ---------- IP 校验 ---------- */
  const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  function isIp(s) {
    const m = IP_RE.exec(String(s || '').trim());
    if (!m) return false;
    for (let i = 1; i <= 4; i++) {
      const n = Number(m[i]);
      if (n < 0 || n > 255) return false;
    }
    return true;
  }

  /* ---------- 下载 ---------- */
  /* file:// 下也能用；安卓 WebView 需由移动端层接管（本版暂不做移动端） */
  function download(filename, content, mime) {
    const blob = (content instanceof Blob)
      ? content
      : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  return {
    uid, hash, hashCode, seededRandom,
    pad, clamp,
    nowStr, todayKey, fmtTime, fmtFull, fmtDur, fmtCycle, freshness, tsTag,
    esc, escAttr,
    num, pct, avg, sum, groupBy, uniqBy,
    debounce, throttle,
    clone, assign,
    csvCell, toCsv,
    truncate, basename, extname, bytes,
    isIp,
    download
  };
})();
