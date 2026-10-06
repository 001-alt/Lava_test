/* ============================================================================
   实时拉取中心 —— 四通道数据接入
   ----------------------------------------------------------------------------
   页面自己连不上 FTP / SSH / 本机目录，全部经桥接服务转发。
   本视图负责：配置、检测、扫描、拉取、看结果。
   ============================================================================ */

const ViewPull = (() => {

  let _scan = null;          // 最近一次扫描结果
  let _log = [];             // 运行日志（界面下方滚动区）
  let _pollTimer = null;
  let _renderSeq = 0;

  function log(msg, cls) {
    _log.unshift({ t: Util.nowStr(), msg, cls: cls || '' });
    if (_log.length > 200) _log.length = 200;
    const box = document.getElementById('pullRunLog');
    if (box) box.innerHTML = runLogHtml();
  }

  function runLogHtml() {
    if (!_log.length) return '<div class="hint" style="margin:0">暂无操作记录</div>';
    return _log.slice(0, 60).map(x =>
      '<div class="ft-runlog ' + x.cls + '">' +
        '<span class="t">' + Util.esc(x.t) + '</span>' + Util.esc(x.msg) +
      '</div>').join('');
  }

  /* --------------------------------------------------------------------------
     渲染
     -------------------------------------------------------------------------- */
  async function render(checkConnection = true) {
    const seq = ++_renderSeq;
    await App.ensureRecords('logindex');
    const cfg = App.cfg;
    const ch = cfg.channels || {};
    const h = Bridge.peekHealth();
    const st = await FtpChannel.status();
    if (seq !== _renderSeq) return;
    const sshSnap = Ssh.lastAt() ? { at: Ssh.lastAt() } : null;
    const sshSum = (App.state.lastSshSummary) || {};

    Dom.html('pullBody',
      '<div class="toolbar">' +
        '<span class="title">实时拉取</span>' +
        '<span class="' + Bridge.healthChipClass(h) + '" id="pullBridgeChip">' +
          Util.esc(Bridge.healthLabel(h)) + '</span>' +
        (h.version ? '<span class="chip">v' + Util.esc(h.version) + '</span>' : '') +
        (h.paramiko === false ? '<span class="chip warn" title="未装 paramiko 时 SSH 只能用密钥认证">' +
          'SSH 仅密钥</span>' : '') +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn" id="btnPullHelp">部署说明</button>' +
        '<button class="btn" id="btnPullSettings">接入设置</button>' +
        '<button class="btn" id="btnPullProbe">检测连接</button>' +
        '<button class="btn" id="btnPullSsh">立即巡检</button>' +
        '<button class="btn primary" id="btnPullNow">拉取日志</button>' +
      '</div>' +

      (h.ok ? '' :
        '<div class="note warn">' +
          (h.pending ? '<b>正在后台检测连接</b>。' : '<b>当前为离线模式</b>。' + Util.esc(h.error || '')) +
          '<br>可正常查看本地数据、导入设备台账、管理工单和导出备份。' +
          'SSH 巡检、FTP 和目录扫描需启动桥接服务；启动后点击「检测连接」。' +
        '</div>') +

      '<div class="cards">' +
        card('已入库盘位', Util.num(App.slots.size),
             '容量 ' + Util.num(Topology.all(cfg).totalSlots) +
             (Topology.hasRegistry() ? ' · 台账模式' : ' · 合成模式')) +
        card('设备台账', Util.num(App.devices.length),
             App.devices.length ? '已导入，可用于巡检与 IP 映射' : '未导入') +
        card('已拉取日志', Util.num((App.logindex || []).length), '份') +
        card('解析记录', Util.num((App.records || []).length), '条') +
        card('巡检机台', h.sshHosts ? Util.num(h.sshHosts) : '—',
             sshSnap ? '上次 ' + Util.fmtTime(sshSnap.at) : '尚未巡检',
             sshSum.online != null ? '在线 ' + sshSum.online + ' / 在测 ' + (sshSum.testing || 0) : '') +
        card('增量标记', Util.num(st.seenCount), '已见过的文件数') +
      '</div>' +

      '<div class="section-title">数据通道</div>' +
      '<div class="cards">' +
        chanCard('机台 SSH 直读', ch.ssh, 'ssh', h,
          '定时只读巡检机台，取在线/在测状态与最新日志时间') +
        chanCard('FTP 日志服务器', ch.ftp, 'ftp', h,
          '扫描并拉取集中存放的日志包；支持增量（只拉变化的）') +
        chanCard('本地目录 / 共享盘', ch.localDir, 'localDir', h,
          '从本机或共享盘的日志目录导入，无需网络接入') +
        chanCard('MES 系统接口', ch.webapp, 'webapp', h,
          '通过 HTTP API 从 MES / 上位系统取数（协议待现场提供）') +
      '</div>' +

      '<div class="section-title">操作' +
        '<span class="note-inline">扫描只读目录，不会修改任何远端文件</span></div>' +
      '<div class="toolbar">' +
        '<button class="btn" id="btnScanFtp">扫描 FTP</button>' +
        '<button class="btn" id="btnScanLocal">扫描本地目录</button>' +
        '<label class="legend-chk"><input type="checkbox" id="chkOnlyNew"' +
          (cfg.settings.onlyNew !== false ? ' checked' : '') + '> 仅拉取新增/变化的文件</label>' +
        '<span class="hint" style="margin:0">单轮最多 ' +
          (cfg.settings.maxFilesPerRun || 80) + ' 个文件</span>' +
      '</div>' +
      '<div id="pullScanResult">' + scanResultHtml() + '</div>' +

      '<div class="section-title">已拉取的日志</div>' +
      logIndexHtml() +

      '<div class="section-title">运行日志</div>' +
      '<div class="ft-runlog-box" id="pullRunLog">' + runLogHtml() + '</div>'
    );
    if (checkConnection) {
      Bridge.health().then(() => {
        App.refreshStatus();
        if (seq === _renderSeq && App.state.curView === 'pull') return render(false);
      }).catch(e => console.warn('[ViewPull] 状态更新失败：', e.message));
    }
  }

  function card(lbl, val, sub, extra) {
    return '<div class="card"><div class="lbl">' + Util.esc(lbl) + '</div>' +
      '<div class="val">' + val + '</div>' +
      (sub ? '<div class="sub">' + Util.esc(sub) + '</div>' : '') +
      (extra ? '<div class="sub">' + Util.esc(extra) + '</div>' : '') + '</div>';
  }

  function chanCard(title, conf, kind, h, desc) {
    const on = conf && conf.enabled;
    let detail = '未配置', state = '', stateCls = '';
    if (kind === 'ssh') {
      detail = (conf.user || '--') + '@' + (conf.logRoot || '未设根目录') + ' :' + (conf.port || 22);
      if (h.sshHosts) {
        state = h.sshReady ? '就绪' : (h.sshMessage || '未就绪');
        stateCls = h.sshReady ? 'ok' : 'warn';
      } else { state = '未下发机台清单'; stateCls = ''; }
    } else if (kind === 'ftp') {
      detail = (conf.host || '未填主机') + ' ' + (conf.basePath || '');
      if (h.ftpConfigured) {
        state = h.ftpConnected ? '已连接' : (h.ftpError || '连接失败');
        stateCls = h.ftpConnected ? 'ok' : 'bad';
      } else { state = '未配置'; }
    } else if (kind === 'localDir') {
      detail = conf.path || '未选目录';
      state = h.localReady ? '就绪' : '未配置';
      stateCls = h.localReady ? 'ok' : '';
    } else {
      detail = conf.baseUrl || '未填地址';
      state = conf.baseUrl ? '已配置（协议待确认）' : '未配置';
      stateCls = conf.baseUrl ? 'warn' : '';
    }

    return '<div class="card">' +
      '<div class="lbl" style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">' +
        Util.esc(title) +
        '<span class="chip ' + (on ? 'ok' : '') + '">' + (on ? '已启用' : '未启用') + '</span>' +
        (state ? '<span class="chip ' + stateCls + '">' + Util.esc(state) + '</span>' : '') +
      '</div>' +
      '<div style="font-size:11.5px;color:var(--tx-2);line-height:1.7;margin:7px 0;min-height:40px">' +
        Util.esc(desc) + '</div>' +
      '<div class="mono" style="font-size:11px;color:var(--tx-3);word-break:break-all">' +
        Util.esc(detail) + '</div>' +
    '</div>';
  }

  function scanResultHtml() {
    if (!_scan) return '<div class="hint">尚未扫描。点「扫描 FTP」或「扫描本地目录」查看可拉取的文件。</div>';
    if (!_scan.files.length) {
      return '<div class="note warn">扫描完成，未找到日志文件。' +
        '请检查通道配置里的根目录是否正确。</div>';
    }
    const show = _scan.files.slice(0, 60);
    return '<div class="note ok">扫描到 <b>' + Util.num(_scan.files.length) + '</b> 个文件' +
      (_scan.files.length > 60 ? '（仅列出前 60）' : '') + '。</div>' +
      DataTable.build([
        { key: 'name', label: '文件名' },
        { key: 'path', label: '路径', fmt: v => Util.truncate(v, 60) },
        { key: 'size', label: '大小', cls: 'num', fmt: v => v ? Util.bytes(v) : '--' },
        { key: 'mtime', label: '修改时间', fmt: v => v ? Util.fmtFull(v) : '--' }
      ], show);
  }

  function logIndexHtml() {
    const idx = App.logindex || [];
    if (!idx.length) return '<div class="empty-tip">尚未拉取任何日志</div>';
    return DataTable.build([
      { key: 'pulledAt', label: '拉取时间', fmt: v => Util.fmtFull(v) },
      { key: 'station', label: '工站', fmt: v => v || '--' },
      { key: 'name', label: '文件名' },
      { key: 'size', label: '大小', cls: 'num', fmt: v => v ? Util.bytes(v) : '--' },
      { key: 'parsed', label: '解析记录', cls: 'num' },
      { key: 'hits', label: '关键词命中', fmt: v =>
        Object.keys(v || {}).map(k => k + '=' + v[k]).join(', ') || '--' }
    ], idx.slice().sort((a, b) => (b.pulledAt || 0) - (a.pulledAt || 0)).slice(0, 100));
  }

  function refreshScan() {
    const el = document.getElementById('pullScanResult');
    if (el) el.innerHTML = scanResultHtml();
  }

  /* --------------------------------------------------------------------------
     动作
     -------------------------------------------------------------------------- */
  async function ensureConfigPushed() {
    if (!Bridge.configured()) {
      Toast.warn('请先在「接入设置」里填写桥接地址');
      return false;
    }
    const h = await Bridge.health();
    if (!h.ok) {
      Toast.warn('当前为离线模式。实时接入需启动桥接服务，再点击「检测连接」。');
      return false;
    }
    try { await Bridge.pushConfig(); return true; }
    catch (e) { Toast.error('下发配置失败：' + e.message); return false; }
  }

  async function probe() {
    log('开始检测桥接连接…');
    const h = await Bridge.health(true);
    App.refreshStatus();
    if (!h.ok) {
      log('桥接不可达：' + (h.error || ''), 'err');
      Toast.error(h.error || '桥接不可达');
      render();
      return;
    }
    log('桥接正常 v' + h.version, 'ok');
    try {
      const r = await Bridge.api('/api/net/selfcheck');
      (r.items || []).forEach(i => log(i.name + '：' + i.message, i.ok ? 'ok' : 'warn'));
    } catch (e) { log('自检失败：' + e.message, 'err'); }
    render();
  }

  async function doScan(kind) {
    if (!await ensureConfigPushed()) return;
    log('开始扫描 ' + (kind === 'local' ? '本地目录' : 'FTP') + '…');
    try {
      const r = await FtpChannel.scanAllRoots(kind);
      _scan = { kind, files: r.files, at: Date.now() };
      r.errors.forEach(e => log('根目录「' + e.root + '」失败：' + e.error, 'err'));
      log('扫描完成，' + r.files.length + ' 个文件', 'ok');
      refreshScan();
    } catch (e) {
      log('扫描失败：' + e.message, 'err');
      Toast.error('扫描失败：' + e.message);
    }
  }

  async function doPull() {
    if (!await ensureConfigPushed()) return;
    const kind = _scan ? _scan.kind : (/本地|local/i.test('') ? 'local' : 'ftp');
    log('开始拉取（' + (App.cfg.settings.onlyNew !== false ? '仅增量' : '全量') + '）…');
    const stat = await FtpChannel.pull(kind === 'local' ? 'local' : 'ftp', {
      onlyNew: App.cfg.settings.onlyNew !== false,
      files: _scan ? _scan.files : null
    });
    if (!stat) { log('拉取未完成', 'err'); return; }
    log('拉取 ' + stat.pulled + ' 个文件（' + Util.bytes(stat.bytes) + '），' +
        '解析 ' + stat.records + ' 条记录' + (stat.failed ? '，失败 ' + stat.failed : ''),
        stat.failed ? 'warn' : 'ok');
    (stat.errors || []).slice(0, 8).forEach(e =>
      log('  ' + (e.file || e.root || '') + '：' + e.error, 'err'));
    await App.loadAll();
    render();
  }

  async function doSsh() {
    if (!await ensureConfigPushed()) return;
    if (!App.devices.length) {
      Toast.warn('尚未导入设备台账，无法知道该巡检哪些 IP');
      return;
    }
    log('下发机台清单…');
    const r = await Bridge.pushHosts();
    log('已下发 ' + r.count + ' 个机台', 'ok');
    log('开始巡检（并发执行，请稍候）…');
    const snap = await Ssh.probeNow();
    if (!snap) { log('巡检失败', 'err'); return; }
    const s = snap.summary || {};
    App.state.lastSshSummary = s;
    log('巡检完成：在线 ' + s.online + ' · 离线 ' + s.offline +
        ' · 在测 ' + s.testing + ' · SSH异常 ' + s.sshError +
        '（' + s.elapsedSec + ' 秒）', s.sshError ? 'warn' : 'ok');
    if (App.state.eqIndexUnmatched) {
      log(' warn：有 ' + App.state.eqIndexUnmatched +
          ' 台机台的 IP 在设备台账里找不到对应设备', 'warn');
    }
    Bus.emit(EVT.SLOTS_CHANGED, { keys: null });
    render();
  }

  function openHelp() {
    const url = Bridge.base() || 'http://127.0.0.1:8770';
    Modal.open({
      title: '桥接服务部署说明',
      size: 'wide',
      body:
        '<div class="note">' +
          '浏览器<b>无法</b>直连 FTP、<b>无法</b>遍历本机任意目录、<b>无法</b> SSH 到机台。' +
          '所以现场数据必须由本机的一个小服务代劳 —— 这就是桥接服务。' +
        '</div>' +

        '<div class="section-title">一、启动</div>' +
        '<div class="hint" style="line-height:2">' +
          '1. 确认本机有 Python 3.8+（<code>python --version</code>）<br>' +
          '2. 双击 <code>bridge\\启动桥接服务.bat</code><br>' +
          '3. 看到「监听地址 http://127.0.0.1:8770」即启动成功，窗口保持开着<br>' +
          '4. 回到本页点「检测连接」' +
        '</div>' +

        '<div class="section-title">二、为什么建议用桥接打开页面</div>' +
        '<div class="note ok">' +
          '启动桥接后，直接访问 <b><a href="' + Util.esc(url) + '" target="_blank">' +
          Util.esc(url) + '</a></b> 打开看板，而不是双击 HTML 文件。<br><br>' +
          '原因：Chrome/Edge 在 <code>file://</code> 协议下会<b>禁用 IndexedDB</b>，' +
          '看板只能退回容量受限的降级存储模式（页面顶部会出现橙色横幅）。' +
          '而 <code>127.0.0.1</code> 是安全上下文，存储、目录授权等功能全部可用。' +
        '</div>' +

        '<div class="section-title">三、SSH 密码认证（可选）</div>' +
        '<div class="hint" style="line-height:2">' +
          '默认只用 Python 标准库，<b>零第三方依赖</b>。<br>' +
          'SSH 若要用密码登录（而不是密钥），需要额外装一个包：<br>' +
          '<code>pip install paramiko</code><br>' +
          (App.state && App.state.bridgeParamiko === false
            ? '<span style="color:var(--warn)">当前未安装，SSH 只能用密钥认证。</span>'
            : '') +
        '</div>' +

        '<div class="section-title">四、只读保证</div>' +
        '<div class="hint" style="line-height:2">' +
          '桥接<b>全链路只读</b>：不写远端、不删日志、不改配置。<br>' +
          'SSH 命令要过白名单校验，<code>rm</code> / <code>dd</code> / <code>&gt;</code> ' +
          '这类写操作一律拒绝。<br>' +
          '文件访问限制在配置的根目录内，<code>../</code> 穿越会被拦截。' +
        '</div>' +
        '<div class="hint" style="margin-top:10px">' +
          '默认<b>仅监听本机</b>。若需手机或其他电脑访问，' +
          '启动时加 <code>--allow-remote --token 你的令牌</code>，' +
          '并在本页「接入设置」里填入同样的令牌。' +
        '</div>',
      footer: '<button class="btn" data-mclose="1">知道了</button>'
    });
  }

  /* --------------------------------------------------------------------------
     事件
     -------------------------------------------------------------------------- */
  function bind() {
    Dom.delegate('pullBody', 'click', '#btnPullProbe', probe);
    Dom.delegate('pullBody', 'click', '#btnPullNow', doPull);
    Dom.delegate('pullBody', 'click', '#btnPullSsh', doSsh);
    Dom.delegate('pullBody', 'click', '#btnScanFtp', () => doScan('ftp'));
    Dom.delegate('pullBody', 'click', '#btnScanLocal', () => doScan('local'));
    Dom.delegate('pullBody', 'click', '#btnPullHelp', openHelp);
    Dom.delegate('pullBody', 'click', '#btnPullSettings', () => ModalSettings.open());
    Dom.delegate('pullBody', 'change', '#chkOnlyNew', (e, el) => {
      App.cfg.settings.onlyNew = el.checked;
      LocalStore.save();
      Toast.ok(el.checked ? '仅拉取新增/变化的文件' : '每轮全量拉取');
    });
  }

  /* 视图可见时若有桥接但从未探测过，自动探一次 */
  async function afterMount() {
    if (Bridge.configured() && !Ssh.lastAt()) {
      // 静默探测，不打扰用户
      Bridge.health().then(h => {
        App.state.bridgeParamiko = h.paramiko;
      });
    }
  }

  return { render, bind, afterMount };
})();
