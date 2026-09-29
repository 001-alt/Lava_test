/* ============================================================================
   FTP / 本地目录通道（页面侧）
   ----------------------------------------------------------------------------
   扫描 → 增量过滤 → 下载 → 入库。

   增量靠 seenFiles（path → mtime）：只有没见过或 mtime 变了的文件才拉。
   现场日志目录动辄上千个文件，全量拉一遍既慢又没必要。

   原始文件会存一份在 rawfiles 表：日志格式尚未确定，
   等格式明确后可以对历史原始日志**离线重解析**，不必重新拉取。
   ============================================================================ */

const FtpChannel = (() => {

  const MAX_FILE = 32 * 1024 * 1024;      // 单个文件上限，防止拉到大文件卡住
  const LOG_EXT = /\.(log|txt|json|csv|xml|ini|out)$/i;

  let _busy = false;
  let _lastScan = null;

  /* --------------------------------------------------------------------------
     扫描
     -------------------------------------------------------------------------- */
  async function scan(kind, opts) {
    const o = opts || {};
    const ch = kind === 'local' ? 'localDir' : 'ftp';
    if (!Bridge.configured()) {
      throw new Error('未配置桥接服务地址');
    }
    const cfg = App.cfg.channels[ch] || {};

    const path = kind === 'local' ? '/api/localscan' : '/api/scan';
    const params = {
      root: o.root || cfg.path || cfg.basePath || '',
      depth: o.depth || App.cfg.settings.scanDepth || 4,
      limit: o.limit || 3000,
      pattern: o.pattern || ''
    };

    const r = await Bridge.api(path, params, { timeout: 60000 });
    const files = (r && r.files) || [];
    _lastScan = { at: Date.now(), kind, count: files.length, files };
    return files;
  }

  /* 扫描所有启用的根目录，合并结果 */
  async function scanAllRoots(kind) {
    const roots = (App.cfg.scanRoots || []).filter(r => r.enabled);
    const out = [];
    const errors = [];
    for (const root of roots) {
      try {
        const files = await scan(kind, { root: root.path });
        files.forEach(f => {
          f.rootId = root.id;
          f.rootName = root.name;
          f.station = root.station || '';
        });
        out.push.apply(out, files);
      } catch (e) {
        errors.push({ root: root.name, error: e.message });
      }
    }
    return { files: out, errors };
  }

  /* --------------------------------------------------------------------------
     增量过滤
     -------------------------------------------------------------------------- */
  async function pickChanged(files, onlyNew) {
    const list = (files || []).filter(f => !f.isDir);
    if (onlyNew === false) return list;

    const seen = await Repo.metaGet('seenFiles', {});
    const fresh = [], skipped = [];
    list.forEach(f => {
      const prev = seen[f.path];
      if (prev === undefined || prev !== f.mtime) fresh.push(f);
      else skipped.push(f);
    });
    return fresh;
  }

  async function markSeen(files) {
    const seen = await Repo.metaGet('seenFiles', {});
    (files || []).forEach(f => { seen[f.path] = f.mtime; });
    // 只保留最近的 20000 条，避免无限增长
    const keys = Object.keys(seen);
    if (keys.length > 20000) {
      keys.slice(0, keys.length - 20000).forEach(k => { delete seen[k]; });
    }
    await Repo.metaSet('seenFiles', seen);
  }

  /* --------------------------------------------------------------------------
     拉取并入库
     -------------------------------------------------------------------------- */
  async function pull(kind, opts) {
    if (_busy) { Toast.warn('上一轮拉取还在进行中'); return null; }
    const o = opts || {};
    _busy = true;

    const stat = { scanned: 0, changed: 0, pulled: 0, skipped: 0, failed: 0,
                   bytes: 0, records: 0, errors: [] };
    try {
      Toast.info('正在扫描远端日志…');
      let files = o.files;
      if (!files) {
        const r = await scanAllRoots(kind);
        files = r.files;
        stat.errors.push.apply(stat.errors, r.errors);
      }
      stat.scanned = files.length;

      const maxFiles = o.maxFiles || App.cfg.settings.maxFilesPerRun || 80;
      const candidates = files
        .filter(f => LOG_EXT.test(f.name) || /_log\.zip$/i.test(f.name))
        .filter(f => !f.size || f.size <= MAX_FILE)
        .slice(0, maxFiles);

      const todo = await pickChanged(candidates, o.onlyNew);
      stat.changed = todo.length;
      stat.skipped = candidates.length - todo.length;

      if (!todo.length) {
        Toast.ok('扫描 ' + stat.scanned + ' 个文件，无新增或变化');
        return stat;
      }

      Toast.info('需拉取 ' + todo.length + ' 个文件（已跳过未变化的 ' + stat.skipped + ' 个）');

      for (let i = 0; i < todo.length; i++) {
        const f = todo[i];
        try {
          const got = await download(kind, f);
          stat.pulled++;
          stat.bytes += got.buffer.byteLength;

          const text = await decodeMaybe(got.buffer);
          await Repo.put('rawfiles', {
            path: f.path,
            name: f.name,
            station: f.station || '',
            size: got.buffer.byteLength,
            mtime: f.mtime || got.mtime || null,
            pulledAt: Date.now(),
            text: text.length > 400000 ? text.slice(0, 400000) : text,
            truncated: text.length > 400000
          });

          const n = await ingestText(text, f);
          stat.records += n;
        } catch (e) {
          stat.failed++;
          stat.errors.push({ file: f.name, error: e.message });
        }
        if ((i + 1) % 10 === 0) Toast.info('已拉取 ' + (i + 1) + ' / ' + todo.length + '…');
      }

      await markSeen(todo);
      await Repo.metaSet('lastPullAt', Date.now());

      Bus.emit(EVT.DATA_LOADED, stat);
      Toast.ok('拉取 ' + stat.pulled + ' 个文件（' + Util.bytes(stat.bytes) + '）' +
               (stat.failed ? '，失败 ' + stat.failed : '') +
               (stat.records ? '，解析出 ' + Util.num(stat.records) + ' 条记录' : ''),
               '拉取完成');
      return stat;
    } catch (e) {
      console.error('[Ftp] 拉取失败：', e);
      Toast.error('拉取失败：' + e.message);
      return null;
    } finally {
      _busy = false;
    }
  }

  async function download(kind, f) {
    if (kind === 'local') {
      const p = f.absPath || f.path;
      return Bridge.fetchBin('/api/localfile', { path: p });
    }
    return Bridge.fetchBin('/api/file', { path: f.path });
  }

  /* 尝试按 UTF-8 解码；解不出就按 GBK 再试（现场日志常是 GBK） */
  async function decodeMaybe(buffer) {
    const bytes = new Uint8Array(buffer);
    try {
      const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return t;
    } catch (e) {
      try {
        return new TextDecoder('gbk').decode(bytes);
      } catch (e2) {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
    }
  }

  /* --------------------------------------------------------------------------
     入库：日志格式未定，先做「原始留档 + 关键词扫描 + 可配置抽取」
     -------------------------------------------------------------------------- */
  async function ingestText(text, file) {
    /* 解析器注册表：目前只有通用实现，现场样例到位后按需增加解析器，
       调用方不用改（这正是把解析做成注册表而不是写死分支的原因）。 */
    if (typeof Pipeline !== 'undefined' && Pipeline.ingest) {
      return Pipeline.ingest(text, {
        fileName: file.name,
        filePath: file.path,
        station: file.station || '',
        rootId: file.rootId || '',
        // 传文件 mtime：日志没带时间戳时用它兜底。
        // 必须是文件自身的确定性属性，不能用当前时间，否则幂等失效。
        mtime: file.mtime || null,
        source: 'ftp'
      });
    }
    // 退路：至少做一次关键词扫描并把命中数记进日志索引
    const scan = Highlight.scan(App.cfg, text, 500);
    await Repo.put('logindex', Schema.newLogIndex({
      path: file.path, name: file.name, station: file.station || '',
      size: (file.size || text.length), mtime: file.mtime || null,
      pulledAt: Date.now(), parsed: 0, hits: scan.summary
    }));
    return 0;
  }

  /* --------------------------------------------------------------------------
     状态
     -------------------------------------------------------------------------- */
  async function status() {
    const seen = await Repo.metaGet('seenFiles', {});
    const lastPullAt = await Repo.metaGet('lastPullAt', 0);
    let raw = 0;
    try { raw = await Repo.count('rawfiles'); } catch (e) { }
    return {
      busy: _busy,
      seenCount: Object.keys(seen).length,
      lastPullAt,
      lastScan: _lastScan,
      rawFiles: raw,
      roots: (App.cfg.scanRoots || []).filter(r => r.enabled).length
    };
  }

  function isBusy() { return _busy; }
  function lastScan() { return _lastScan; }

  return { scan, scanAllRoots, pickChanged, markSeen, pull, status, isBusy, lastScan, decodeMaybe };
})();
