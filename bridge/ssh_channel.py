# -*- coding: utf-8 -*-
"""
SSH 只读巡检通道
============================================================================
职责：定时巡检机台，回答三个问题
    1. 在线吗？（SSH 连得上 = 开机在线）
    2. 在测吗？（测试进程在不在跑）
    3. 测完了吗？（日志目录最新文件的时间）

**全链路只读**：只执行 ls / cat / ps / uptime 这类读命令，
任何写操作在 security.check_command 就被拒了。

并发：产线有数百台设备，串行 SSH 一轮要几十分钟。用线程池并发，
默认 20 并发，可按现场网络调整。

依赖：paramiko（可选）。装了就能用密码认证；没装则回退到系统 ssh 命令，
只能走密钥认证。核心的 FTP / 本地目录 / 静态托管不需要任何第三方包。
"""

import re
import time
import socket
import subprocess
import threading

try:
    import paramiko
    HAS_PARAMIKO = True
except ImportError:
    paramiko = None
    HAS_PARAMIKO = False

from security import check_command, ForbiddenOperation


class SshError(Exception):
    pass


# 巡检脚本：输出若干 KEY=VALUE 行，便于解析。
# 全部为只读命令；用 ; 串联，单条失败不影响其余。
PROBE_SCRIPT = r'''
echo "HN=$(hostname 2>/dev/null)"
echo "UP=$(cut -d. -f1 /proc/uptime 2>/dev/null || uptime 2>/dev/null)"
echo "PS=$(ps -eo comm,args 2>/dev/null | grep -v grep | grep -ci "__TESTPAT__" 2>/dev/null || echo 0)"
echo "LD=$(ls -t __LOGROOT__ 2>/dev/null | head -1)"
echo "LT=$(stat -c %Y "__LOGROOT__" 2>/dev/null || echo 0)"
'''

SSH_ERR_LABEL = {
    'timeout': '连接超时',
    'refused': '拒绝连接（SSH 未启动？）',
    'auth': '认证失败',
    'neterr': '网络不可达',
    'hostkey': '主机密钥校验失败',
    'unknown': '未知错误',
}


def classify_error(msg):
    """把各种库的报错归到有限几类，前端按类展示"""
    s = str(msg or '').lower()
    if 'timed out' in s or 'timeout' in s:
        return 'timeout'
    if 'refused' in s:
        return 'refused'
    if 'auth' in s or 'password' in s or 'permission denied' in s:
        return 'auth'
    if 'unreachable' in s or 'no route' in s or 'network' in s:
        return 'neterr'
    if 'host key' in s or 'hostkey' in s:
        return 'hostkey'
    return 'unknown'


def _reachable(ip, port, timeout):
    """先做一次 TCP 探测：SSH 连不上时能快速失败，不必等完整握手"""
    try:
        s = socket.create_connection((ip, port), timeout=timeout)
        s.close()
        return True
    except Exception:
        return False


class SshChannel(object):
    """只读巡检 + 日志读取"""

    def __init__(self, cfg=None):
        self._lock = threading.Lock()
        self._hosts = []          # [{ip, station, equipmentId, ...}]
        self._snapshot = {'at': 0, 'hosts': [], 'summary': {}}
        self._cache = {}          # ip -> 上次成功的结果，本轮失败时沿用
        self._polling = False
        self._stop = threading.Event()
        self.set_config(cfg or {})

    # -- 配置 ---------------------------------------------------------------
    def set_config(self, cfg):
        self.user = str(cfg.get('user') or 'root')
        self.port = int(cfg.get('port') or 22)
        self.password = str(cfg.get('password') or '')
        self.key_path = str(cfg.get('keyPath') or '')
        self.auth = str(cfg.get('auth') or 'auto')       # auto | password | key
        self.interval = max(10, int(cfg.get('intervalSec') or 60))
        self.workers = max(1, min(64, int(cfg.get('workers') or 20)))
        self.timeout = max(2, int(cfg.get('timeout') or 8))
        # 测试进程特征：现场测试程序名未知，做成可配置
        self.test_pattern = str(cfg.get('testProcessPattern')
                                or 'slt|test|ssd|dml|burn')
        self.log_root = str(cfg.get('logRoot') or '/home/dml_slt_test/dml_slt_test_logs')

    def ready(self):
        if not self._hosts:
            return False, '未下发机台清单'
        if self.auth == 'password' and not HAS_PARAMIKO:
            return False, '密码认证需要 paramiko：pip install paramiko'
        return True, ''

    # -- 机台清单 -----------------------------------------------------------
    def set_hosts(self, hosts):
        clean = []
        seen = set()
        for h in (hosts or []):
            ip = str(h.get('ip') or '').strip()
            if not ip or ip in seen:
                continue
            seen.add(ip)
            clean.append({
                'ip': ip,
                'station': h.get('station') or '',
                'equipmentId': h.get('equipmentId') or '',
                'cabinet': h.get('cabinet') or '',
            })
        with self._lock:
            self._hosts = clean
            # 清单里没有的缓存清掉，避免残留设备一直显示旧状态
            keep = set(x['ip'] for x in clean)
            self._cache = {k: v for k, v in self._cache.items() if k in keep}
        return len(clean)

    def hosts(self):
        with self._lock:
            return list(self._hosts)

    # -- 单机执行 -----------------------------------------------------------
    def _run(self, ip, command):
        """
        在单台机器上跑一条只读命令，返回 stdout 文本。
        优先 paramiko；没装且是密钥认证时回退到系统 ssh。
        """
        check_command(command)   # 只读守卫：不合规直接抛

        if HAS_PARAMIKO and self.auth != 'key':
            return self._run_paramiko(ip, command)
        return self._run_cli(ip, command)

    def _run_paramiko(self, ip, command):
        cli = paramiko.SSHClient()
        cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        kw = dict(hostname=ip, port=self.port, username=self.user,
                  timeout=self.timeout, banner_timeout=self.timeout,
                  auth_timeout=self.timeout)
        if self.auth == 'key' or (self.auth == 'auto' and self.key_path and not self.password):
            kw['key_filename'] = self.key_path
            kw['look_for_keys'] = True
        else:
            kw['password'] = self.password
            kw['look_for_keys'] = False
            kw['allow_agent'] = False
        try:
            cli.connect(**kw)
            _in, out, err = cli.exec_command(command, timeout=self.timeout)
            data = out.read().decode('utf-8', 'replace')
            cli.close()
            return data
        except Exception as e:
            try:
                cli.close()
            except Exception:
                pass
            raise SshError(str(e))

    def _run_cli(self, ip, command):
        args = ['ssh', '-o', 'BatchMode=yes',
                '-o', 'StrictHostKeyChecking=no',
                '-o', 'ConnectTimeout=%d' % self.timeout,
                '-p', str(self.port)]
        if self.key_path:
            args += ['-i', self.key_path]
        args += ['%s@%s' % (self.user, ip), command]
        try:
            p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=self.timeout + 5)
        except subprocess.TimeoutExpired:
            raise SshError('timeout')
        except FileNotFoundError:
            raise SshError('系统没有 ssh 命令，且未安装 paramiko')
        if p.returncode != 0:
            raise SshError(p.stderr.decode('utf-8', 'replace') or 'ssh 退出码 %d' % p.returncode)
        return p.stdout.decode('utf-8', 'replace')

    # -- 巡检 ---------------------------------------------------------------
    def _probe_one(self, host):
        ip = host['ip']
        res = {
            'ip': ip, 'station': host.get('station', ''),
            'equipmentId': host.get('equipmentId', ''),
            'cabinet': host.get('cabinet', ''),
            'checkedAt': int(time.time() * 1000),
            'power': 'unknown', 'testing': False,
            'errorKind': 'none', 'errorHint': '',
            'hostname': '', 'uptimeSec': None,
            'latestLog': '', 'latestLogTime': None, 'stale': False,
        }
        try:
            script = (PROBE_SCRIPT
                      .replace('__TESTPAT__', self.test_pattern)
                      .replace('__LOGROOT__', self.log_root))
            out = self._run(ip, script)
            kv = {}
            for line in out.splitlines():
                if '=' in line:
                    k, v = line.split('=', 1)
                    kv[k.strip()] = v.strip()

            res['power'] = 'on'
            res['hostname'] = kv.get('HN', '')
            if kv.get('LT') and kv['LT'].isdigit() and int(kv['LT']) > 0:
                res['latestLogTime'] = int(kv['LT']) * 1000
            res['latestLog'] = kv.get('LD', '') or ''
            try:
                n = int(kv.get('PS', '0') or 0)
                res['testing'] = n > 0
            except ValueError:
                res['testing'] = False

            # 日志很旧 = 该机台虽然在线但没在测（可能空闲或卡住）
            if res['latestLogTime']:
                age = time.time() * 1000 - res['latestLogTime']
                res['logAgeSec'] = int(age / 1000)
            with self._lock:
                self._cache[ip] = res
            return res

        except (SshError, ForbiddenOperation) as e:
            msg = str(e)
            kind = classify_error(msg)
            cached = self._cache.get(ip)
            if cached:
                # 本轮失败时沿用上次结果，但明确标出「这是旧数据」
                res = dict(cached)
                res['stale'] = True
                res['staleSec'] = int((time.time() * 1000 - cached['checkedAt']) / 1000)
            res['errorKind'] = kind
            res['errorHint'] = SSH_ERR_LABEL.get(kind, '未知错误')
            res['errorMsg'] = msg[:300]
            # SSH 不通时，若 TCP 也不通基本可判定离线
            if kind in ('timeout', 'neterr', 'refused') and not res.get('stale'):
                res['power'] = 'off'
            return res

    def probe(self, only_ips=None):
        """并发巡检一轮，返回快照"""
        hosts = self.hosts()
        if only_ips:
            want = set(only_ips)
            hosts = [h for h in hosts if h['ip'] in want]
        if not hosts:
            return self.snapshot()

        t0 = time.time()
        results = []
        try:
            from concurrent.futures import ThreadPoolExecutor, as_completed
            with ThreadPoolExecutor(max_workers=self.workers) as ex:
                futs = {ex.submit(self._probe_one, h): h for h in hosts}
                for f in as_completed(futs):
                    try:
                        results.append(f.result())
                    except Exception as e:
                        h = futs[f]
                        results.append({
                            'ip': h['ip'], 'station': h.get('station', ''),
                            'equipmentId': h.get('equipmentId', ''),
                            'power': 'unknown', 'testing': False,
                            'errorKind': 'unknown', 'errorHint': str(e)[:200],
                            'checkedAt': int(time.time() * 1000),
                        })
        except ImportError:
            for h in hosts:
                results.append(self._probe_one(h))

        results.sort(key=lambda x: x['ip'])
        summary = {
            'total': len(results),
            'online': sum(1 for r in results if r.get('power') == 'on'),
            'offline': sum(1 for r in results if r.get('power') == 'off'),
            'testing': sum(1 for r in results if r.get('testing')),
            'sshError': sum(1 for r in results if r.get('errorKind') not in ('none', '', None)),
            'stale': sum(1 for r in results if r.get('stale')),
            'elapsedSec': round(time.time() - t0, 1),
        }
        snap = {'at': int(time.time() * 1000), 'hosts': results, 'summary': summary}
        with self._lock:
            self._snapshot = snap
        return snap

    def snapshot(self):
        with self._lock:
            return self._snapshot

    # -- 后台轮询 -----------------------------------------------------------
    def start_polling(self):
        if self._polling:
            return
        self._polling = True
        self._stop.clear()
        t = threading.Thread(target=self._poll_loop, name='ssh-poll', daemon=True)
        t.start()

    def stop_polling(self):
        self._stop.set()
        self._polling = False

    def _poll_loop(self):
        # 启动后先等 3 秒，避开与页面首屏同时抢网络
        if self._stop.wait(3):
            return
        while not self._stop.is_set():
            try:
                if self._hosts:
                    self.probe()
            except Exception as e:
                print('[ssh] 巡检异常：%s' % e)
            # 分片等待，便于及时响应停止
            for _ in range(self.interval):
                if self._stop.wait(1):
                    return

    # -- 日志读取 -----------------------------------------------------------
    def ls(self, ip, dir_path):
        out = self._run(ip, 'ls -la --time-style=+%%s %s' % _q(dir_path))
        entries = []
        for line in out.splitlines():
            parts = line.split(None, 6)
            if len(parts) < 7 or parts[0][0] not in '-dl':
                continue
            name = parts[6]
            if name in ('.', '..'):
                continue
            entries.append({
                'name': name,
                'isDir': parts[0][0] == 'd',
                'size': None if parts[0][0] == 'd' else _int(parts[4]),
                'mtime': _int(parts[5]) * 1000 if _int(parts[5]) else None,
            })
        entries.sort(key=lambda x: (not x['isDir'], -(x['mtime'] or 0)))
        return entries

    def cat(self, ip, file_path, max_bytes=512 * 1024):
        out = self._run(ip, 'head -c %d %s' % (max_bytes, _q(file_path)))
        return out

    def slt_latest(self, ip, root, max_bytes=2 * 1024 * 1024):
        """取测试日志根目录下最新的一个日志文件内容"""
        script = ('D=$(ls -t %s 2>/dev/null | head -1); '
                  '[ -n "$D" ] && { echo "DIR=$D"; '
                  'F=$(ls -t %s/$D 2>/dev/null | head -1); '
                  '[ -n "$F" ] && { echo "FILE=$F"; '
                  'head -c %d %s/$D/$F; }; }'
                  % (_q(root), _q(root), max_bytes, _q(root)))
        return self._run(ip, script)

    def upload_cmd(self, ip, command):
        """执行一条自定义的**只读**命令（仍走白名单校验）"""
        return self._run(ip, command)


def _q(s):
    """shell 单引号转义"""
    return "'" + str(s).replace("'", "'\\''") + "'"


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
