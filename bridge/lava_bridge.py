# -*- coding: utf-8 -*-
"""
Lava_test 桥接服务
============================================================================
浏览器为什么需要它
----------------------------------------------------------------------------
页面跑在浏览器里，而浏览器**不能**直连 FTP、**不能**遍历本机任意目录、
也**不能** SSH 到机台。所以现场数据必须由本机的一个小服务代劳。

它做三件事：
    1. 代浏览器访问 FTP / 本地目录 / MES 接口，把结果转成 HTTP 返回
    2. 定时 SSH 只读巡检机台，维护一份状态快照供页面拉取
    3. 托管看板页面到 http://127.0.0.1:8770/  ——
       这是安全上下文，IndexedDB 全功能可用，
       解决了 file:// 下浏览器禁用 IndexedDB 导致的存储降级

零第三方依赖
----------------------------------------------------------------------------
只用 Python 标准库（http.server / ftplib / urllib）。
现场机器常常装不了 pip 包，零依赖意味着「有 Python 就能跑」。
SSH 密码认证需要 paramiko（可选）；没装则回退到系统 ssh 命令走密钥认证。

只读保证
----------------------------------------------------------------------------
所有对外操作都是读：不写远端、不删日志、不改配置。
SSH 命令要过白名单校验（见 security.py），写操作直接拒绝。

用法
----------------------------------------------------------------------------
    python lava_bridge.py                    # 默认 127.0.0.1:8770
    python lava_bridge.py --port 8770 --serve-web
    python lava_bridge.py --allow-remote --token 你的令牌
    python lava_bridge.py --selftest         # 自检，不起服务
"""

import os
import sys
import json
import time
import argparse
import threading
import secrets
import hmac

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from security import AccessControl, ForbiddenOperation, check_command  # noqa: E402
import channels as ch                                                  # noqa: E402
import ssh_channel as sshmod                                           # noqa: E402
from sqlite_store import SQLiteStore                                   # noqa: E402

VERSION = '1.0.0'
START_AT = time.time()

# ⚠️ Windows 控制台默认代码页是 GBK(936)，直接 print 中文会乱码，
#    遇到 ✓ ✗ 这类符号更会直接抛 UnicodeEncodeError 把服务打断。
#    统一改成 UTF-8 输出（reconfigure 是 Python 3.7+ 才有的）。
#    启动脚本里还会配合 chcp 65001，两者缺一不可。
for _s in ('stdout', 'stderr'):
    _stream = getattr(sys, _s, None)
    try:
        if _stream and hasattr(_stream, 'reconfigure'):
            _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


# ===========================================================================
# 服务状态（进程级单例）
# ===========================================================================
class Bridge(object):
    def __init__(self):
        self.cfg = {
            'ftp': {}, 'local': {'roots': []}, 'mes': {},
            'ssh': {}, 'webRoot': '',
        }
        self.ftp = ch.FtpChannel()
        self.local = ch.LocalChannel()
        self.mes = ch.MesChannel()
        self.ssh = sshmod.SshChannel()
        self.acl = AccessControl()
        self.last_error = ''
        self._probe_cache = {}     # 通道健康检查结果缓存（避免阻塞式实时探测）
        self.storage = None
        self.storage_token = secrets.token_urlsafe(32)

    def enable_storage(self, path):
        self.storage = SQLiteStore(path)

    def invalidate_health(self, key=None):
        """配置变更后清掉缓存，让下次 health 立即重新探测"""
        if key:
            self._probe_cache.pop(key, None)
        else:
            self._probe_cache.clear()

    def apply_config(self, incoming):
        """页面下发配置。合并而不是替换 —— 页面不必每次都传全量。"""
        if not isinstance(incoming, dict):
            return
        for key in ('ftp', 'local', 'mes', 'ssh'):
            if isinstance(incoming.get(key), dict):
                self.cfg[key] = dict(self.cfg.get(key) or {})
                self.cfg[key].update(incoming[key])
        if incoming.get('webRoot'):
            self.cfg['webRoot'] = str(incoming['webRoot'])

        self.ftp.set_config(self.cfg['ftp'])
        self.local.set_config(self.cfg['local'])
        self.mes.set_config(self.cfg['mes'])
        # 配置变了，健康检查缓存随之失效，否则会继续报旧状态
        self.invalidate_health()

        ssh_cfg = dict(self.cfg['ssh'])
        # SSH 密码来自页面（页面不存它），其余参数桥接侧也可配置
        self.ssh.set_config(ssh_cfg)
        if ssh_cfg.get('intervalSec') or ssh_cfg.get('enabled'):
            self.ssh.start_polling()
        return self.cfg

    # -----------------------------------------------------------------------
    # 通道健康检查缓存
    # -----------------------------------------------------------------------
    # ⚠️ 健康检查**绝不能**做无缓存的阻塞网络 I/O。
    #    早期版本每次 /api/health 都实时连一次 FTP，FTP 不可达时会阻塞满
    #    超时（20 秒），页面上的「检测连接」和自动刷新全被拖死。
    #    现在：探测用短超时 + 结果缓存 TTL，健康检查最多慢 3 秒，通常瞬时返回。
    HEALTH_TTL = 30          # 缓存有效期（秒）
    HEALTH_TIMEOUT = 3       # 探测用的短超时

    def _cached(self, key, probe):
        now = time.time()
        hit = self._probe_cache.get(key)
        if hit and now - hit[0] < self.HEALTH_TTL:
            return hit[1], hit[2], True
        try:
            r = probe()
        except Exception as e:
            r = (False, str(e))
        self._probe_cache[key] = (now, r[0], r[1])
        return r[0], r[1], False

    def health(self):
        ftp_ok, ftp_msg, ftp_cached = (
            self._cached('ftp', lambda: self.ftp.test(timeout=self.HEALTH_TIMEOUT))
            if self.ftp.configured else (False, '未配置 FTP', True))
        local_ok, local_msg, _ = (
            self._cached('local', self.local.test)
            if self.local.roots else (False, '未配置本地目录', True))
        ssh_ok, ssh_msg = self.ssh.ready()
        snap = self.ssh.snapshot()
        return {
            'ok': True,
            'service': 'lava-bridge',
            'version': VERSION,
            'python': sys.version.split()[0],
            'paramiko': sshmod.HAS_PARAMIKO,
            'uptimeSec': int(time.time() - START_AT),
            'ftpConfigured': self.ftp.configured,
            'ftpConnected': ftp_ok,
            'ftpError': '' if ftp_ok else ftp_msg,
            'ftpCached': ftp_cached,
            'localReady': local_ok,
            'localError': '' if local_ok else local_msg,
            'sshReady': ssh_ok,
            'sshMessage': ssh_msg,
            'sshHosts': len(self.ssh.hosts()),
            'sshLastProbe': snap.get('at') or 0,
            'webServed': bool(self.web_root()),
        }

    def web_root(self):
        """找到看板页面所在目录。优先配置，其次猜常见的几个位置。"""
        cands = []
        if self.cfg.get('webRoot'):
            cands.append(self.cfg['webRoot'])
        here = os.path.dirname(os.path.abspath(__file__))
        cands += [os.path.dirname(here),                      # bridge/ 的上级
                  os.path.join(os.path.dirname(here), 'dist'),
                  here]
        for d in cands:
            if d and (os.path.isfile(os.path.join(d, 'Lava_test看板.html')) or
                      os.path.isfile(os.path.join(d, 'LavaTestBoard.html'))):
                return d
        return ''


BRIDGE = Bridge()


# ===========================================================================
# HTTP 处理
# ===========================================================================
class Handler(BaseHTTPRequestHandler):
    server_version = 'LavaBridge/' + VERSION
    protocol_version = 'HTTP/1.1'

    # 关掉默认的逐请求日志噪声，只在出错时打印
    def log_message(self, fmt, *args):
        if str(args[1] if len(args) > 1 else '').startswith(('4', '5')):
            sys.stderr.write('[bridge] %s %s\n' % (self.address_string(), fmt % args))

    # -- 公共 ---------------------------------------------------------------
    def _cors(self):
        # SQLite desktop mode is same-origin only; never expose the bootstrap
        # token to arbitrary websites through wildcard CORS.
        if BRIDGE.storage:
            return
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Expose-Headers', 'X-File-Name, X-File-Mtime')

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _bin(self, data, filename, mtime=None, code=200):
        self.send_response(code)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        if filename:
            from urllib.parse import quote
            self.send_header('X-File-Name', quote(filename))
        if mtime:
            self.send_header('X-File-Mtime', str(int(mtime / 1000)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _text(self, text, code=200, ctype='text/plain; charset=utf-8'):
        body = text.encode('utf-8') if isinstance(text, str) else text
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, code=400):
        self._json({'ok': False, 'error': str(msg)}, code)

    def _auth(self):
        """返回 True 表示放行"""
        tok = self.headers.get('X-Bridge-Token', '')
        ok, reason = BRIDGE.acl.check(self.client_address[0], tok)
        if not ok:
            self._err(reason, 403)
            return False
        return True

    def _query(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def _storage_auth(self):
        if not BRIDGE.storage:
            self._err('SQLite 未启用', 404)
            return False
        origin = self.headers.get('Origin')
        port = self.server.server_address[1]
        allowed = ('http://127.0.0.1:%d' % port, 'http://localhost:%d' % port)
        host = self.headers.get('Host', '')
        if host not in ('127.0.0.1:%d' % port, 'localhost:%d' % port) or (origin and origin not in allowed):
            self._err('存储接口仅允许本机同源访问', 403)
            return False
        if not hmac.compare_digest(self.headers.get('X-Lava-Storage-Token', ''), BRIDGE.storage_token):
            self._err('存储会话令牌不正确', 403)
            return False
        return True

    # -- 入口 ---------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self._auth():
            return
        path = urlparse(self.path).path
        q = self._query()
        try:
            self._route_get(path, q)
        except ForbiddenOperation as e:
            self._err('只读守卫拒绝：%s' % e, 403)
        except ch.ChannelError as e:
            self._err(str(e), 502)
        except sshmod.SshError as e:
            self._err('SSH 失败：%s' % e, 502)
        except FileNotFoundError as e:
            self._err('文件不存在：%s' % e, 404)
        except Exception as e:
            BRIDGE.last_error = str(e)
            import traceback
            traceback.print_exc()
            self._err('服务内部错误：%s' % e, 500)

    def do_POST(self):
        if not self._auth():
            return
        path = urlparse(self.path).path
        try:
            if path == '/api/storage' and not self._storage_auth():
                return
            length = int(self.headers.get('Content-Length') or 0)
            if length < 0 or length > 32 * 1024 * 1024:
                self.close_connection = True
                return self._err('请求体过大', 413)
            raw = self.rfile.read(length) if length else b''
            try:
                body = json.loads(raw.decode('utf-8')) if raw else {}
            except ValueError:
                return self._err('无效 JSON', 400)
            self._route_post(path, body)
        except ForbiddenOperation as e:
            self._err('只读守卫拒绝：%s' % e, 403)
        except (ValueError, TypeError) as e:
            self._err(str(e), 400)
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._err('服务内部错误：%s' % e, 500)

    # -- GET 路由 -----------------------------------------------------------
    def _route_get(self, path, q):
        B = BRIDGE

        if path == '/api/health':
            return self._json(B.health())

        if path == '/api/net/selfcheck':
            return self._json(self.net_selfcheck())

        # --- FTP ---
        if path == '/api/scan':
            files = B.ftp.scan(root=q.get('root'), depth=int(q.get('depth') or 4),
                               limit=int(q.get('limit') or 3000),
                               pattern=q.get('pattern') or None)
            return self._json({'ok': True, 'files': files, 'count': len(files)})

        if path == '/api/file':
            p = q.get('path') or ''
            if not p:
                return self._err('缺少 path')
            data, name, mtime = B.ftp.read(p)
            return self._bin(data, name, mtime)

        # --- 本地目录 ---
        if path == '/api/local':
            return self._json({'ok': True, 'entries': B.local.list_dir(q.get('path') or '')})

        if path == '/api/localfile':
            p = q.get('path') or ''
            if not p:
                return self._err('缺少 path')
            data, name, mtime = B.local.read(p)
            return self._bin(data, name, mtime)

        if path == '/api/localscan':
            files = B.local.scan(root=q.get('root'), depth=int(q.get('depth') or 4),
                                 limit=int(q.get('limit') or 3000),
                                 pattern=q.get('pattern') or None)
            return self._json({'ok': True, 'files': files, 'count': len(files)})

        # --- SSH ---
        if path == '/api/ssh/status':
            return self._json(B.ssh.snapshot())

        if path == '/api/ssh/probe':
            only = [x for x in (q.get('ips') or '').split(',') if x] or None
            return self._json(B.ssh.probe(only))

        if path == '/api/ssh/ls':
            return self._json({'ok': True, 'entries': B.ssh.ls(q.get('ip') or '',
                                                              q.get('dir') or '.')})

        if path == '/api/ssh/cat':
            maxb = int(q.get('max') or 524288)
            return self._text(B.ssh.cat(q.get('ip') or '', q.get('file') or '', maxb))

        if path == '/api/ssh/slt':
            return self._text(B.ssh.slt_latest(q.get('ip') or '',
                                               q.get('root') or B.ssh.log_root))

        # --- MES ---
        if path == '/api/mes':
            return self._json(B.mes.fetch(q.get('endpoint') or ''))

        if path == '/api/workorder-options':
            return self._json(B.mes.fetch('workorders'))

        # --- 静态托管 ---
        return self._serve_static(path)

    # -- POST 路由 ----------------------------------------------------------
    def _route_post(self, path, body):
        B = BRIDGE

        if path == '/api/storage':
            return self._json({'ok': True, 'result': B.storage.execute(body)})

        if path == '/api/config':
            B.apply_config(body or {})
            return self._json({'ok': True})

        if path == '/api/ssh/hosts':
            n = B.ssh.set_hosts((body or {}).get('hosts') or [])
            return self._json({'ok': True, 'count': n})

        if path == '/api/shutdown':
            # 只允许本机（_auth 已保证），便于脚本化重启
            self._json({'ok': True, 'message': '服务即将退出'})
            threading.Thread(target=lambda: (time.sleep(0.4), os._exit(0))).start()
            return

        return self._err('未知接口：%s' % path, 404)

    # -- 网络自检 -----------------------------------------------------------
    def net_selfcheck(self):
        """
        检查各通道可达性。不主动扫描网段 —— 网段扫描在产线网络里
        可能触发 IDS 或被当成异常流量，改为「按配置项逐个探测」。
        """
        out = {'ok': True, 'items': []}
        B = BRIDGE

        def add(name, ok, msg, detail=''):
            out['items'].append({'name': name, 'ok': bool(ok),
                                 'message': msg, 'detail': detail})

        add('桥接服务', True, '运行中 v' + VERSION)

        if B.ftp.configured:
            ok, msg = B.ftp.test()
            add('FTP（%s:%s）' % (B.ftp.host, B.ftp.port), ok, msg)
        else:
            add('FTP', False, '未配置')

        ok, msg = B.local.test()
        add('本地目录', ok, msg)

        if B.mes.configured:
            ok, msg = B.mes.test()
            add('MES（%s）' % B.mes.base_url, ok, msg)
        else:
            add('MES', False, '未配置')

        if B.ssh.hosts():
            snap = B.ssh.snapshot()
            s = snap.get('summary') or {}
            add('SSH 巡检', bool(snap.get('at')),
                '在线 %s / 离线 %s / 在测 %s' % (s.get('online', 0), s.get('offline', 0),
                                                 s.get('testing', 0)),
                '共 %d 台，上次巡检 %s' % (len(B.ssh.hosts()),
                    time.strftime('%H:%M:%S', time.localtime(snap['at'] / 1000)) if snap.get('at') else '尚未'))
            add('paramiko', sshmod.HAS_PARAMIKO,
                '已安装（支持密码认证）' if sshmod.HAS_PARAMIKO else
                '未安装，SSH 仅支持密钥认证；需要密码认证请 pip install paramiko')
        else:
            add('SSH 巡检', False, '未下发机台清单')

        out['ok'] = all(i['ok'] for i in out['items'] if i['name'] not in ('MES', 'paramiko'))
        return out

    # -- 静态文件 -----------------------------------------------------------
    def _serve_static(self, path):
        if BRIDGE.storage:
            port = self.server.server_address[1]
            if self.headers.get('Host', '') not in ('127.0.0.1:%d' % port, 'localhost:%d' % port):
                return self._err('无效本地主机地址', 403)
        root = BRIDGE.web_root()
        if not root:
            return self._text(
                'Lava_test 桥接服务运行中（v%s）\n\n'
                '未找到看板页面。请把构建产物 Lava_test看板.html 放在 %s 下，\n'
                '或用 --web-root 指定目录。\n\n'
                '接口自检：GET /api/health\n'
                % (VERSION, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                200)

        rel = path.lstrip('/') or 'Lava_test看板.html'
        from security import safe_join
        try:
            full = safe_join(root, rel)
        except ForbiddenOperation:
            return self._err('路径越界', 403)

        if os.path.isdir(full):
            names = ('Lava_test看板.html', 'LavaTestBoard.html')
            full = next((os.path.join(full, n) for n in names
                         if os.path.isfile(os.path.join(full, n))), os.path.join(full, names[0]))
        if not os.path.isfile(full):
            return self._err('未找到：%s' % rel, 404)

        ctype = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        }.get(os.path.splitext(full)[1].lower(), 'application/octet-stream')

        with open(full, 'rb') as f:
            data = f.read()
        if BRIDGE.storage and os.path.basename(full) == 'Lava_test看板.html':
            runtime = json.dumps({'storage': 'sqlite', 'url': 'http://127.0.0.1:%d' % self.server.server_address[1],
                                  'token': BRIDGE.storage_token}, ensure_ascii=True)
            bootstrap = '<script>window.LAVA_RUNTIME=%s;</script>' % runtime
            data = data.replace(b'<head>', b'<head>' + bootstrap.encode('utf-8'), 1)
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self._cors()
        self.end_headers()
        self.wfile.write(data)


# ===========================================================================
# 自检
# ===========================================================================
def selftest():
    print('=' * 66)
    print('Lava_test 桥接服务 · 自检')
    print('=' * 66)
    print('Python      : %s' % sys.version.split()[0])
    print('paramiko    : %s' % ('已安装' if sshmod.HAS_PARAMIKO else '未安装（SSH 仅密钥认证）'))
    print('服务版本    : v%s' % VERSION)

    failed = 0

    # 只读守卫
    print('\n[只读守卫]')
    cases = [
        ('ls -la /tmp', True), ('cat /var/log/x.log', True), ('find /data -name "*.log"', True),
        ('rm -rf /tmp/x', False), ('echo hi > /etc/passwd', False),
        ('cat x | tee y', False), ('sudo reboot', False), ('dd if=/dev/zero of=/dev/sda', False),
    ]
    for cmd, should_pass in cases:
        try:
            check_command(cmd)
            got = True
        except ForbiddenOperation:
            got = False
        mark = '✓' if got == should_pass else '✗'
        if got != should_pass:
            failed += 1
        print('  %s %-32s %s' % (mark, cmd, '放行' if got else '拒绝'))

    # 路径穿越
    print('\n[路径穿越防护]')
    import tempfile
    d = tempfile.mkdtemp()
    for rel, should_pass in [('a/b.txt', True), ('../../etc/passwd', False),
                             ('/etc/passwd', True)]:
        try:
            from security import safe_join
            p = safe_join(d, rel)
            ok = p.startswith(os.path.realpath(d))
        except ForbiddenOperation:
            ok = False
        mark = '✓' if ok == should_pass else '✗'
        if ok != should_pass:
            failed += 1
        print('  %s %-24s %s' % (mark, rel, '在根内' if ok else '已拦截'))

    # 静态托管
    print('\n[静态托管]')
    wr = BRIDGE.web_root()
    print('  %s 看板目录：%s' % ('✓' if wr else '○', wr or '未找到（用 --web-root 指定）'))

    # 配置加载
    print('\n[配置]')
    print('  ✓ 当前配置项：%s' % ', '.join(k for k in BRIDGE.cfg))

    print('\n' + '=' * 66)
    if failed:
        print('自检失败 %d 项' % failed)
        return 1
    print('自检通过')
    return 0


# ===========================================================================
# 启动
# ===========================================================================
def main():
    ap = argparse.ArgumentParser(description='Lava_test 桥接服务')
    ap.add_argument('--host', default='127.0.0.1',
                    help='监听地址。默认只监听本机；远程访问需 --allow-remote')
    ap.add_argument('--port', type=int, default=8770)
    ap.add_argument('--allow-remote', action='store_true',
                    help='允许非本机访问（必须同时配置 --token）')
    ap.add_argument('--token', default='', help='访问令牌（远程访问必填）')
    ap.add_argument('--web-root', default='', help='看板页面所在目录')
    ap.add_argument('--config', default='', help='从 JSON 文件加载初始配置')
    ap.add_argument('--database', default='', help='启用 SQLite 并指定数据库文件')
    ap.add_argument('--selftest', action='store_true', help='只做自检，不启动服务')
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())

    if args.web_root:
        BRIDGE.cfg['webRoot'] = args.web_root
    if args.database:
        if args.allow_remote:
            ap.error('SQLite 模式目前仅支持本机访问')
        BRIDGE.enable_storage(args.database)

    if args.config and os.path.isfile(args.config):
        try:
            with open(args.config, 'r', encoding='utf-8') as f:
                BRIDGE.apply_config(json.load(f))
            print('[bridge] 已加载配置 %s' % args.config)
        except Exception as e:
            print('[bridge] 配置加载失败：%s' % e)

    if args.allow_remote and not args.token:
        print('[bridge] ⚠️  --allow-remote 必须配合 --token，已自动关闭远程访问')
        args.allow_remote = False
    BRIDGE.acl = AccessControl(args.token, args.allow_remote)

    # 页面下发的 SSH 配置里带密码；这里先按已加载配置决定是否开始轮询
    if BRIDGE.ssh.hosts():
        BRIDGE.ssh.start_polling()

    host = args.host if args.allow_remote else '127.0.0.1'
    srv = ThreadingHTTPServer((host, args.port), Handler)
    srv.daemon_threads = True

    wr = BRIDGE.web_root()
    print('=' * 66)
    print(' Lava_test 桥接服务 v%s' % VERSION)
    print('=' * 66)
    print(' 监听地址 : http://%s:%d' % (host, args.port))
    print(' 看板页面 : %s' % (('http://%s:%d/' % (host, args.port)) if wr
                              else '未找到（把 Lava_test看板.html 放到上级目录，或用 --web-root 指定）'))
    print(' paramiko : %s' % ('已安装' if sshmod.HAS_PARAMIKO else '未安装（SSH 仅密钥认证）'))
    print(' 远程访问 : %s' % ('允许（需令牌）' if args.allow_remote else '禁止（仅本机）'))
    print(' 远端操作 : 只读；本地 SQLite 数据支持持久化写入' if BRIDGE.storage
          else ' 只读模式 : 全链路只读，写操作一律拒绝')
    print('-' * 66)
    print(' 按 Ctrl+C 停止')
    print('=' * 66)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n[bridge] 正在停止…')
    finally:
        BRIDGE.ssh.stop_polling()
        srv.shutdown()
        srv.server_close()
        if BRIDGE.storage:
            BRIDGE.storage.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
