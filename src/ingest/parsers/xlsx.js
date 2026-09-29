/* ============================================================================
   xlsx 解析器 —— 零依赖
   ----------------------------------------------------------------------------
   xlsx 本质是一个 zip：xl/workbook.xml（表名）、xl/sharedStrings.xml（共享串）、
   xl/worksheets/sheetN.xml（单元格）。

   解压用 DecompressionStream('deflate-raw')：
     · 浏览器：Chrome/Edge 103+ 原生支持
     · Node 18+：同样有全局 DecompressionStream
   因此同一份代码在页面与 Node 脚本里都能跑，不必为测试另写一套。

   ⚠️ 只做读取，不写 xlsx。
   ============================================================================ */

const Xlsx = (() => {

  const dec = new TextDecoder('utf-8');

  /* --------------------------------------------------------------------------
     ZIP 中央目录解析
     从尾部倒扫 EOCD 魔数定位，再逐条读中央目录项拿到本地头偏移
     -------------------------------------------------------------------------- */
  function readZipEntries(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    let eocd = -1;
    const maxBack = Math.min(u8.length, 66560);        // EOCD 注释最长 64KB
    for (let i = u8.length - 22; i >= u8.length - maxBack && i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx / zip 文件（找不到 EOCD 记录）');

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const cmtLen = dv.getUint16(p + 32, true);
      entries.push({
        name: dec.decode(u8.subarray(p + 46, p + 46 + nameLen)),
        method: dv.getUint16(p + 10, true),
        compSize: dv.getUint32(p + 20, true),
        localOff: dv.getUint32(p + 42, true)
      });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    if (!entries.length) throw new Error('zip 中央目录为空');
    return { u8, dv, entries };
  }

  /* 读单个条目的原始字节（未解压） */
  function entryBytes(zip, entry) {
    const { u8, dv } = zip;
    const p = entry.localOff;
    if (dv.getUint32(p, true) !== 0x04034b50) throw new Error('本地文件头损坏：' + entry.name);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const start = p + 30 + nameLen + extraLen;
    return u8.subarray(start, start + entry.compSize);
  }

  /* deflate-raw 解压（浏览器与 Node 18+ 通用） */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 DecompressionStream，无法解压 xlsx（需 Chrome/Edge 103+）');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* 取条目文本（method 0=store 直接读，8=deflate 解压） */
  async function entryText(zip, entry) {
    const raw = entryBytes(zip, entry);
    if (entry.method === 0) return dec.decode(raw);
    if (entry.method === 8) return dec.decode(await inflateRaw(raw));
    throw new Error('不支持的压缩方式 ' + entry.method + '：' + entry.name);
  }

  /* --------------------------------------------------------------------------
     XML 小工具 —— 不引依赖，够用即可
     -------------------------------------------------------------------------- */
  function unesc(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
      .replace(/&amp;/g, '&');
  }
  function attr(tag, name) {
    const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
    return m ? unesc(m[1]) : '';
  }
  function innerText(xml, tag) {
    const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'g');
    const out = []; let m;
    while ((m = re.exec(xml))) out.push(m[1]);
    return out;
  }

  /* A1 → {col, row}（col 从 1 起） */
  function refOf(ref) {
    const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(String(ref || '').trim());
    if (!m) return null;
    let col = 0;
    for (let i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
    return { col, row: Number(m[2]) };
  }
  function colName(n) {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  /* --------------------------------------------------------------------------
     解析工作簿
     返回 { sheets: [ { name, rows: [ [cell,…], … ] } ] }
       rows 为稀疏补齐后的二维数组（下标 0 对应 A 列），行号与 xlsx 一致（下标 0 对应第 1 行）
     -------------------------------------------------------------------------- */
  async function parse(arrayBuffer) {
    const zip = readZipEntries(arrayBuffer);
    const byName = {};
    zip.entries.forEach(e => { byName[e.name] = e; });

    /* 共享字符串 */
    let shared = [];
    if (byName['xl/sharedStrings.xml']) {
      const xml = await entryText(zip, byName['xl/sharedStrings.xml']);
      shared = innerText(xml, 'si').map(si =>
        innerText(si, 't').map(t => unesc(t.replace(/<[^>]+>/g, ''))).join(''));
    }

    /* 表名（按 workbook.xml 顺序） */
    let names = [];
    if (byName['xl/workbook.xml']) {
      const xml = await entryText(zip, byName['xl/workbook.xml']);
      names = innerText(xml, 'sheet').map(s => attr(s, 'name'));
    }

    /* 工作表（按 sheetN.xml 数字序） */
    const sheetFiles = zip.entries
      .map(e => e.name)
      .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(/(\d+)/.exec(a)[1]), nb = Number(/(\d+)/.exec(b)[1]);
        return na - nb;
      });

    const sheets = [];
    for (let i = 0; i < sheetFiles.length; i++) {
      const xml = await entryText(zip, byName[sheetFiles[i]]);
      const rowTags = xml.match(/<row\b[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || [];
      const rows = [];

      rowTags.forEach(rb => {
        const rowNum = Number(attr(rb, 'r')) || (rows.length + 1);
        const cells = [];
        const cellTags = rb.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || [];
        cellTags.forEach(ct => {
          const pos = refOf(attr(ct, 'r'));
          if (!pos) return;
          const t = attr(ct, 't');
          let v = '';
          if (t === 's') {
            const m = /<v>([\s\S]*?)<\/v>/.exec(ct);
            const idx = m ? Number(unesc(m[1])) : -1;
            v = (idx >= 0 && shared[idx] != null) ? shared[idx] : '';
          } else if (t === 'inlineStr') {
            v = innerText(ct, 't').map(x => unesc(x.replace(/<[^>]+>/g, ''))).join('');
          } else if (t === 'str') {
            const m = /<v>([\s\S]*?)<\/v>/.exec(ct);
            v = m ? unesc(m[1]) : '';
          } else {
            const m = /<v>([\s\S]*?)<\/v>/.exec(ct);
            v = m ? unesc(m[1]) : '';
          }
          cells[pos.col - 1] = String(v).trim();
        });
        // 补齐稀疏列
        for (let c = 0; c < cells.length; c++) if (cells[c] === undefined) cells[c] = '';
        rows[rowNum - 1] = cells;
      });

      // 补齐稀疏行
      for (let r = 0; r < rows.length; r++) if (!rows[r]) rows[r] = [];

      sheets.push({ name: names[i] || sheetFiles[i], rows });
    }

    return { sheets, sheetNames: names };
  }

  return { parse, readZipEntries, entryText, inflateRaw, refOf, colName, unesc, attr, innerText };
})();

/* Node 环境导出，供 tools/ 下的脚本复用同一套解析逻辑 */
if (typeof module !== 'undefined' && module.exports) module.exports = Xlsx;
