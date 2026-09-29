/* ============================================================================
   节拍调度
   ----------------------------------------------------------------------------
   三类周期性任务：

     renderTick  重绘当前视图 + 拉 SSH 快照（默认 300 秒）
     sshTick     只拉巡检快照（默认 60 秒）
     pullTick    增量拉取日志（默认由「拉取间隔」控制）

   三条不变量（沿用 RDIMM 的经验，这几条不做就会出问题）：

     1. **页面不可见时不跑** —— 最小化/切后台时跳过，省网络也省机台负载
     2. **每个任务自带 busy 锁** —— 上一轮没跑完不启动下一轮，避免叠加
     3. **只由一个节拍驱动** —— 开启「自动刷新」时，SSH 与拉取都挂在它的
        节拍上，不再各自起定时器；否则两套节拍会打架，同一时刻跑两遍
   ============================================================================ */

const Scheduler = (() => {

  let _timers = {};
  let _state = {};
  let _running = false;
  let _nextAt = 0;
  let _countdownTimer = null;

  function task(name) {
    _state[name] = _state[name] || { busy: false, lastAt: 0, lastMs: 0, runs: 0, errors: 0 };
    return _state[name];
  }

  /* 包装：加 busy 锁 + 计时 + 异常兜底 */
  function guard(name, fn) {
    const t = task(name);
    return async function () {
      if (t.busy) return false;
      t.busy = true;
      const t0 = Date.now();
      try {
        await fn();
        t.lastMs = Date.now() - t0;
        t.runs++;
        t.lastAt = Date.now();
        return true;
      } catch (e) {
        t.errors++;
        t.lastAt = Date.now();
        console.warn('[Scheduler] ' + name + ' 出错：', e.message);
        return false;
      } finally {
        t.busy = false;
      }
    };
  }

  function visible() {
    return !document.hidden;
  }

  /* --------------------------------------------------------------------------
     一个节拍里做什么
     -------------------------------------------------------------------------- */
  const tickRender = guard('render', async () => {
    if (!visible()) return;
    // 重绘当前视图
    try { await App.switchView(App.state.curView); } catch (e) { }
    // 顺带拉一次巡检（自动刷新开启时由这里统一驱动）
    if (Bridge.configured()) {
      await Ssh.poll(true);
      App.refreshStatus();
    }
  });

  const tickSsh = guard('ssh', async () => {
    if (!visible()) return;
    if (!Bridge.configured()) return;
    await Ssh.poll(true);
    Bus.emit(EVT.SLOTS_CHANGED, { keys: null });   // 让平面图重绘状态
  });

  const tickPull = guard('pull', async () => {
    if (!visible()) return;
    if (!Bridge.configured()) return;
    if (!App.cfg.settings.autoPull) return;
    await FtpChannel.pull('ftp', { onlyNew: App.cfg.settings.onlyNew !== false });
  });

  /* --------------------------------------------------------------------------
     启动 / 停止
     -------------------------------------------------------------------------- */
  function start() {
    stop();
    _running = true;
    const sec = Math.max(15, App.cfg.settings.refreshSec || 60);
    _nextAt = Date.now() + sec * 1000;

    // 主节拍：重绘 + 巡检
    _timers.render = setInterval(() => {
      _nextAt = Date.now() + sec * 1000;
      tickRender();
    }, sec * 1000);

    // SSH 单独一个更快的节拍，但**只在没开自动刷新时**才起作用
    _timers.ssh = setInterval(() => {
      if (_timers.render) return;      // 自动刷新开着 → 由 renderTick 统一驱动
      tickSsh();
    }, Math.max(20, (App.cfg.channels.ssh || {}).intervalSec || 60) * 1000);

    // 倒计时显示
    _countdownTimer = setInterval(updateChip, 1000);

    console.log('[Scheduler] 已启动，节拍 ' + sec + ' 秒');
    updateChip();
    tickRender();      // 立即跑一次，不用等第一个周期
  }

  function stop() {
    Object.keys(_timers).forEach(k => { if (_timers[k]) clearInterval(_timers[k]); });
    _timers = {};
    if (_countdownTimer) clearInterval(_countdownTimer);
    _countdownTimer = null;
    _running = false;
    updateChip();
  }

  function toggle() {
    if (_running) { stop(); Toast.ok('自动刷新已关闭'); }
    else { start(); Toast.ok('自动刷新已开启（每 ' +
      Math.max(15, App.cfg.settings.refreshSec || 60) + ' 秒）'); }
    return _running;
  }

  function isRunning() { return _running; }

  function updateChip() {
    const el = document.getElementById('tickChip');
    if (!el) return;
    if (!_running) {
      el.textContent = '自动刷新：关';
      el.className = 'chip';
      el.title = '点击「自动刷新」开启周期性刷新与巡检';
      return;
    }
    const left = Math.max(0, Math.round((_nextAt - Date.now()) / 1000));
    el.textContent = '自动刷新：' + left + 's';
    el.className = 'chip ok';
    const t = _state.render || {};
    el.title = '每 ' + Math.max(15, App.cfg.settings.refreshSec || 60) + ' 秒一轮\n' +
      '已运行 ' + (t.runs || 0) + ' 轮' +
      (t.lastMs ? '，上轮耗时 ' + (t.lastMs / 1000).toFixed(1) + ' 秒' : '') +
      (t.errors ? '\n失败 ' + t.errors + ' 次' : '') +
      '\n页面不可见时自动跳过';
  }

  function status() {
    return { running: _running, nextInSec: Math.max(0, Math.round((_nextAt - Date.now()) / 1000)),
             tasks: Util.clone(_state) };
  }

  /* 页面重新可见时补一次，避免切回来看到的还是旧数据 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _running) {
      _nextAt = Date.now() + Math.max(15, App.cfg.settings.refreshSec || 60) * 1000;
      tickRender();
    }
  });

  return { start, stop, toggle, isRunning, status, tickRender, tickSsh, tickPull };
})();
