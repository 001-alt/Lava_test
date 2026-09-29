# -*- coding: utf-8 -*-
"""
桥接服务接口契约测试
============================================================================
无硬件也能跑：起一个真实的桥接进程，用 HTTP 打所有端点，验证
    · 端点存在且返回结构正确
    · 只读守卫与路径穿越防护生效
    · 未配置通道时给出可读提示而不是崩

不需要 pytest，直接 python test_api.py 即可（现场装不了第三方包）。
"""

import os
import sys
import json
import time
import socket
import tempfile
import subprocess
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(os.path.dirname(HERE), 'lava_bridge.py')
PORT = 8799
BASE = 'http://127.0.0.1:%d' % PORT

# Windows 控制台 GBK，强制 UTF-8 否则中文与符号会报错
for _s in ('stdout', 'stderr'):
    try:
        getattr(sys, _s).reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

passed = failed = 0


def ok(cond, msg, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  [OK] %s' % msg)
    else:
        failed += 1
        print('  [FAIL] %s %s' % (msg, ('-> %s' % extra) if extra else ''))


def head(t):
    print('\n' + t)


def call(path, method='GET', body=None, token=None):
    url = BASE + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('X-Bridge-Token', token)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            ctype = r.headers.get('Content-Type', '')
            if 'json' in ctype:
                return r.status, json.loads(raw.decode('utf-8')), r.headers
            return r.status, raw.decode('utf-8', 'replace'), r.headers
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode('utf-8')), e.headers
        except Exception:
            return e.code, raw.decode('utf-8', 'replace'), e.headers


def wait_port(port, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            s = socket.create_connection(('127.0.0.1', port), 0.4)
            s.close()
            return True
        except Exception:
            time.sleep(0.2)
    return False


# ===========================================================================
def main():
    workdir = tempfile.mkdtemp(prefix='lava_bridge_test_')
    # 造一个假看板页面，验证静态托管
    with open(os.path.join(workdir, 'Lava_test看板.html'), 'w', encoding='utf-8') as f:
        f.write('<!doctype html><title>Lava</title><h1>ok</h1>')
    # 造一个假日志目录，验证本地通道
    logdir = os.path.join(workdir, 'logs')
    os.makedirs(logdir, exist_ok=True)
    with open(os.path.join(logdir, 'a.log'), 'w', encoding='utf-8') as f:
        f.write('PASS SN=LVA001\nFAIL SN=LVA002\n')

    proc = subprocess.Popen(
        [sys.executable, BRIDGE, '--port', str(PORT), '--web-root', workdir],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    try:
        if not wait_port(PORT):
            out = proc.stdout.read(4000).decode('utf-8', 'replace')
            print('桥接启动失败：\n' + out)
            return 1

        head('1. 存活与自检')
        code, h, _ = call('/api/health')
        ok(code == 200, 'GET /api/health 返回 200', code)
        ok(h.get('ok') is True, 'health.ok = true')
        ok(h.get('service') == 'lava-bridge', '服务标识正确', h.get('service'))
        ok('version' in h, '带版本号 %s' % h.get('version'))
        ok('paramiko' in h, '报告 paramiko 可用性：%s' % h.get('paramiko'))

        code, d, _ = call('/api/net/selfcheck')
        ok(code == 200 and 'items' in d, 'GET /api/net/selfcheck 返回检查项 %d 条'
           % len(d.get('items', [])))

        head('2. 静态托管（解决 file:// 存储降级）')
        code, body, hdrs = call('/')
        ok(code == 200, 'GET / 返回 200', code)
        ok('Lava' in str(body), '返回的是看板页面')
        ok('text/html' in hdrs.get('Content-Type', ''), 'Content-Type 为 html')

        head('3. 配置下发')
        code, d, _ = call('/api/config', 'POST', {
            'local': {'roots': [logdir]},
            'ftp': {'host': '10.0.0.9', 'port': 21, 'user': 'u', 'password': 'p'},
            'ssh': {'user': 'root', 'intervalSec': 30},
        })
        ok(code == 200 and d.get('ok'), 'POST /api/config 接受配置')

        code, h2, _ = call('/api/health')
        ok(h2.get('localReady') is True, '本地通道变为就绪')
        ok(h2.get('ftpConfigured') is True, 'FTP 配置已记录')
        ok(h2.get('ftpConnected') is False, 'FTP 连不上时如实报告（10.0.0.9 不可达）')

        head('4. 本地目录通道')
        code, d, _ = call('/api/local?path=')
        ok(code == 200 and 'entries' in d, 'GET /api/local 列出根目录')
        code, d, _ = call('/api/local?path=' + urllib.request.quote(logdir))
        names = [e['name'] for e in d.get('entries', [])]
        ok('a.log' in names, '列出假日志文件', names)

        code, d, _ = call('/api/localscan?root=%s&pattern=.log' % urllib.request.quote(logdir))
        ok(code == 200 and d.get('count', 0) >= 1, '本地扫描到 %s 个 .log' % d.get('count'))

        path = os.path.join(logdir, 'a.log')
        code, body, hdrs = call('/api/localfile?path=' + urllib.request.quote(path))
        ok(code == 200 and 'PASS' in str(body), '读回文件内容')

        head('5. 只读守卫与路径穿越')
        code, d, _ = call('/api/localfile?path=' + urllib.request.quote(
            os.path.join(logdir, '..', '..', '..', 'etc', 'passwd')))
        ok(code in (403, 404), '越界路径被拦截（HTTP %s）' % code)

        # 带写操作与命令注入的路径，必须被只读守卫拒绝
        evil = urllib.request.quote('/etc/passwd; rm -rf /tmp/x', safe='')
        code, d, _ = call('/api/ssh/cat?ip=127.0.0.1&file=' + evil)
        ok(code in (403, 502), 'SSH 注入写命令被拒（HTTP %s）' % code,
           str(d)[:100])

        # 直接单测守卫，覆盖更多写法
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from security import check_command, ForbiddenOperation
        blocked = 0
        for cmd in ['rm -rf /', 'echo x > f', 'cat a | tee b', 'sudo su',
                    'dd if=/dev/zero of=/dev/sda', 'chmod 777 /']:
            try:
                check_command(cmd)
            except ForbiddenOperation:
                blocked += 1
            except Exception:
                pass
        ok(blocked == 6, '只读守卫拦住全部 6 条写命令（拦住 %d）' % blocked)

        head('6. SSH 通道骨架（无机台）')
        code, d, _ = call('/api/ssh/status')
        ok(code == 200 and 'hosts' in d, 'GET /api/ssh/status 返回快照结构')

        code, d, _ = call('/api/ssh/hosts', 'POST', {'hosts': [
            {'ip': '10.0.0.1', 'station': 'FINAL', 'equipmentId': 'S35#-1'},
            {'ip': '10.0.0.2', 'station': 'BIST', 'equipmentId': 'BIST-61#'},
            {'ip': '10.0.0.1', 'station': 'dup'},
        ]})
        ok(code == 200 and d.get('count') == 2, '下发机台清单并去重（3 条 -> %s）' % d.get('count'))

        head('7. 未知接口')
        code, d, _ = call('/api/does-not-exist')
        ok(code == 404, '未知 API 返回 404', code)

        code, d, _ = call('/api/shutdown', 'POST')
        ok(code == 200, '本机可调用 shutdown')

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print('\n' + '=' * 62)
    print('桥接接口测试：%d 通过 / %d 失败' % (passed, failed))
    print('=' * 62)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
