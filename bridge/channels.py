# -*- coding: utf-8 -*-
"""
数据通道：FTP / 本地目录 / MES
============================================================================
全部只读。三条通道对外提供同样的两个能力：

    scan(root, ...)  ->  [{path, name, size, mtime}, ...]
    read(path, ...)  ->  (bytes, filename, mtime)

浏览器不能直接连 FTP，也不能可靠地遍历本机任意目录，
所以这三件事必须由桥接代劳。

MES 是 HTTP 通道，实现为「可配置的转发」—— 现场接口协议还没定，
不写死任何字段，只做 URL 拼接 + 认证头注入 + 原样返回。
"""

import os
import io
import ssl
import time
import json
import ftplib
import socket
import urllib.request
import urllib.parse
import urllib.error

from security import safe_join, in_allowed_roots, ForbiddenOperation


class ChannelError(Exception):
    """通道层错误，带可读原因"""
    pass


# ===========================================================================
# FTP
# ===========================================================================
class FtpChannel(object):
    """
    只读 FTP 客户端。
    每次操作按需连接、用完即断 —— 现场 FTP 常有连接数限制，
    长连接反而容易把服务器占满。
    """

    def __init__(self, cfg=None):
        self.set_config(cfg or {})
        self._last_error = ''

    def set_config(self, cfg):
        self.host = str(cfg.get('host') or '').strip()
        self.port = int(cfg.get('port') or 21)
        self.user = str(cfg.get('user') or '')
        self.password = str(cfg.get('password') or '')
        self.passive = cfg.get('passive', True)
        self.encoding = cfg.get('encoding') or 'utf-8'
        self.timeout = int(cfg.get('timeout') or 20)
        self.base_path = str(cfg.get('basePath') or '').rstrip('/')

    @property
    def configured(self):
        return bool(self.host)

    def _connect(self):
        if not self.configured:
            raise ChannelError('未配置 FTP 主机')
        try:
            ftp = ftplib.FTP()
            ftp.encoding = self.encoding
            ftp.connect(self.host, self.port, timeout=self.timeout)
            ftp.login(self.user, self.password)
            ftp.set_pasv(bool(self.passive))
            return ftp
        except ftplib.all_errors as e:
            self._last_error = str(e)
            raise ChannelError('FTP 连接失败：%s' % e)
        except socket.timeout:
            self._last_error = 'timeout'
            raise ChannelError('FTP 连接超时（%s:%s）' % (self.host, self.port))

    def test(self, timeout=None):
        """
        连通性检测，返回 (ok, message)。
        timeout 可临时覆盖 —— 健康检查用短超时，避免 FTP 不可达时
        把整个 /api/health 请求拖满几十秒。
        """
        if not self.configured:
            return False, '未配置 FTP 主机'
        old = self.timeout
        if timeout:
            self.timeout = timeout
        try:
            ftp = self._connect()
            try:
                ftp.voidcmd('NOOP')
                try:
                    ftp.cwd(self.base_path or '/')
                    welcome = '根目录 %s 可访问' % (self.base_path or '/')
                except ftplib.all_errors:
                    welcome = '根目录 %s 不存在或无权限' % self.base_path
                return True, welcome or 'FTP 正常'
            finally:
                _quiet_quit(ftp)
        except ChannelError as e:
            return False, str(e)
        finally:
            self.timeout = old

    # -- 扫描 ---------------------------------------------------------------
    def scan(self, root=None, depth=4, limit=3000, pattern=None):
        """
        递归列出文件。返回 [{path, name, size, mtime}]
        path 为相对 base_path 的路径，前端用它再取内容。
        """
        start = self._resolve_root(root)
        out = []
        ftp = self._connect()
        try:
            self._walk(ftp, start, depth, limit, out, pattern)
        finally:
            _quiet_quit(ftp)
        out.sort(key=lambda x: x.get('mtime') or 0, reverse=True)
        return out[:limit]

    def _resolve_root(self, root):
        r = (root or self.base_path or '/').rstrip('/')
        return r or '/'

    def _walk(self, ftp, path, depth, limit, out, pattern):
        if len(out) >= limit or depth < 0:
            return
        try:
            entries = []
            ftp.retrlines('LIST', entries.append)
        except ftplib.all_errors as e:
            # 单个目录读不了不该中断整轮扫描
            out.append({'_error': '%s: %s' % (path, e)}) if False else None
            return

        dirs, files = _parse_listing(entries)
        for name in files:
            if len(out) >= limit:
                return
            if pattern and pattern.lower() not in name.lower():
                continue
            full = path.rstrip('/') + '/' + name
            size, mtime = self._size_mtime(ftp, full)
            out.append({
                'path': self._rel(full),
                'name': name,
                'size': size,
                'mtime': mtime,
            })
        for name in dirs:
            if len(out) >= limit:
                return
            self._walk(ftp, path.rstrip('/') + '/' + name, depth - 1, limit, out, pattern)

    def _size_mtime(self, ftp, full):
        """SIZE 与 MDTM 都不是所有 FTP 服务器都支持，失败就算了"""
        size, mtime = None, None
        try:
            ftp.voidcmd('TYPE I')
            size = ftp.size(full)
        except ftplib.all_errors:
            pass
        try:
            resp = ftp.sendcmd('MDTM ' + full)
            if resp[:3] == '213':
                mtime = _parse_mdtm(resp[4:].strip())
        except ftplib.all_errors:
            pass
        return size, mtime

    def _rel(self, full):
        """转成相对 base_path 的路径，前端拿它来取文件"""
        b = self.base_path
        if b and full.startswith(b):
            return full[len(b):].lstrip('/')
        return full.lstrip('/')

    # -- 读取 ---------------------------------------------------------------
    def read(self, path, max_bytes=64 * 1024 * 1024):
        full = (self.base_path.rstrip('/') + '/' + str(path).lstrip('/')) if self.base_path \
            else '/' + str(path).lstrip('/')
        ftp = self._connect()
        try:
            buf = io.BytesIO()
            ftp.voidcmd('TYPE I')
            ftp.retrbinary('RETR ' + full, buf.write, blocksize=65536)
            data = buf.getvalue()
        except ftplib.all_errors as e:
            raise ChannelError('读取失败 %s：%s' % (path, e))
        finally:
            _quiet_quit(ftp)

        mtime = None
        try:
            name = os.path.basename(full)
        except Exception:
            name = 'download.bin'
        return data[:max_bytes], name, mtime


def _quiet_quit(ftp):
    try:
        ftp.quit()
    except Exception:
        try:
            ftp.close()
        except Exception:
            pass


def _parse_listing(lines):
    """
    解析 LIST 输出。
    Unix 风格： -rw-r--r-- 1 owner group 12345 Aug 27 10:30 filename
    Windows IIS 风格： 08-27-26  10:30AM  <DIR>  dirname
                      08-27-26  10:30AM         1234 filename
    """
    dirs, files = [], []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        parts = ln.split(None, 8)
        if len(parts) >= 9 and parts[0][0] in '-dl':
            name = parts[8]
            if name in ('.', '..'):
                continue
            (dirs if parts[0][0] == 'd' else files).append(name)
            continue
        # IIS 风格
        m = ln.split(None, 3)
        if len(m) == 4:
            if m[2] == '<DIR>':
                if m[3] not in ('.', '..'):
                    dirs.append(m[3])
            else:
                files.append(m[3])
    return dirs, files


def _parse_mdtm(s):
    # YYYYMMDDHHMMSS -> 毫秒时间戳
    try:
        t = time.strptime(s[:14], '%Y%m%d%H%M%S')
        return int(time.mktime(t) * 1000)
    except Exception:
        return None


# ===========================================================================
# 本地目录
# ===========================================================================
class LocalChannel(object):
    """读取桥接所在机器的本地/共享盘目录"""

    def __init__(self, cfg=None):
        self.set_config(cfg or {})

    def set_config(self, cfg):
        self.roots = [r for r in (cfg.get('roots') or []) if r]
        self.path = str(cfg.get('path') or '')

    def _allowed_roots(self):
        roots = list(self.roots)
        if self.path:
            roots.append(self.path)
        return [r for r in roots if r]

    def test(self):
        roots = self._allowed_roots()
        if not roots:
            return False, '未配置本地目录'
        ok = [r for r in roots if os.path.isdir(r)]
        if not ok:
            return False, '配置的目录都不存在：%s' % ', '.join(roots)
        return True, '可用目录 %d 个' % len(ok)

    def list_dir(self, path):
        """列出目录内容。path 为空时列出所有允许的根。"""
        if not path:
            out = []
            for r in self._allowed_roots():
                out.append({
                    'name': r, 'path': r, 'isDir': True,
                    'size': None, 'mtime': _mtime(r), 'root': True,
                })
            return out

        target = os.path.realpath(path)
        if not in_allowed_roots(target, self._allowed_roots()):
            raise ForbiddenOperation('目录不在允许范围内：%s' % path)
        if not os.path.isdir(target):
            raise ChannelError('不是目录：%s' % path)

        out = []
        try:
            for name in sorted(os.listdir(target)):
                if name.startswith('.'):
                    continue
                full = os.path.join(target, name)
                try:
                    is_dir = os.path.isdir(full)
                    out.append({
                        'name': name, 'path': full, 'isDir': is_dir,
                        'size': None if is_dir else os.path.getsize(full),
                        'mtime': _mtime(full),
                    })
                except OSError:
                    continue
        except OSError as e:
            raise ChannelError('读取目录失败：%s' % e)
        return out

    def scan(self, root=None, depth=4, limit=3000, pattern=None):
        """递归扫描，返回文件列表（与 FTP 通道同构）"""
        base = root or (self._allowed_roots() or [None])[0]
        if not base:
            raise ChannelError('未指定目录')
        target = os.path.realpath(base)
        if not in_allowed_roots(target, self._allowed_roots()):
            raise ForbiddenOperation('目录不在允许范围内：%s' % base)

        out = []
        base_depth = target.rstrip(os.sep).count(os.sep)
        for dirpath, dirnames, filenames in os.walk(target):
            if len(out) >= limit:
                break
            if dirpath.count(os.sep) - base_depth >= depth:
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames
                           if not d.startswith('.')
                           and d not in ('node_modules', '__pycache__', '.git')]
            for fn in filenames:
                if len(out) >= limit:
                    break
                if pattern and pattern.lower() not in fn.lower():
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                out.append({
                    'path': os.path.relpath(full, target).replace('\\', '/'),
                    'absPath': full,
                    'name': fn,
                    'size': st.st_size,
                    'mtime': int(st.st_mtime * 1000),
                })
        out.sort(key=lambda x: x.get('mtime') or 0, reverse=True)
        return out[:limit]

    def read(self, path, max_bytes=64 * 1024 * 1024):
        target = os.path.realpath(path)
        if not in_allowed_roots(target, self._allowed_roots()):
            raise ForbiddenOperation('路径不在允许范围内：%s' % path)
        if not os.path.isfile(target):
            raise ChannelError('不是文件：%s' % path)
        size = os.path.getsize(target)
        if size > max_bytes:
            raise ChannelError('文件过大（%.1f MB），上限 %.0f MB'
                               % (size / 1048576.0, max_bytes / 1048576.0))
        with open(target, 'rb') as f:
            data = f.read()
        return data, os.path.basename(target), int(os.path.getmtime(target) * 1000)


def _mtime(path):
    try:
        return int(os.path.getmtime(path) * 1000)
    except OSError:
        return None


# ===========================================================================
# MES（HTTP 接口转发）
# ===========================================================================
class MesChannel(object):
    """
    可配置的 HTTP 转发。
    现场 MES 协议未定，因此不写死任何字段：
    只按配置拼 URL、注入认证头、把响应原样带回给前端解析。
    """

    def __init__(self, cfg=None):
        self.set_config(cfg or {})

    def set_config(self, cfg):
        self.base_url = str(cfg.get('baseUrl') or '').rstrip('/')
        self.token = str(cfg.get('token') or '')
        self.auth_header = cfg.get('authHeader') or 'Authorization'
        self.auth_prefix = cfg.get('authPrefix') or 'Bearer '
        self.timeout = int(cfg.get('timeout') or 20)
        self.verify_ssl = cfg.get('verifySsl', True)
        self.endpoints = cfg.get('endpoints') or {}

    @property
    def configured(self):
        return bool(self.base_url)

    def test(self):
        if not self.configured:
            return False, '未配置 MES 地址'
        url = self.base_url + '/'
        try:
            code, _ = self._request(url, timeout=6)
            return True, 'HTTP %s' % code
        except Exception as e:
            return False, str(e)

    def _opener(self):
        if self.verify_ssl:
            return urllib.request.build_opener()
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))

    def _request(self, url, params=None, timeout=None):
        if params:
            sep = '&' if '?' in url else '?'
            url = url + sep + urllib.parse.urlencode(params)
        req = urllib.request.Request(url)
        if self.token:
            req.add_header(self.auth_header, self.auth_prefix + self.token)
        req.add_header('Accept', 'application/json')
        try:
            with self._opener().open(req, timeout=timeout or self.timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except urllib.error.URLError as e:
            raise ChannelError('MES 请求失败：%s' % e.reason)

    def fetch(self, endpoint, params=None):
        """按配置的端点名取数据。endpoint 可以是名字或直接给路径。"""
        if not self.configured:
            raise ChannelError('未配置 MES 地址')
        path = self.endpoints.get(endpoint) or endpoint
        if not str(path).startswith('/'):
            path = '/' + str(path)
        code, body = self._request(self.base_url + path, params)
        if code >= 400:
            raise ChannelError('MES 返回 HTTP %s' % code)
        text = body.decode('utf-8', 'replace')
        try:
            return json.loads(text)
        except ValueError:
            # 不是 JSON 就原样回文本，交给前端决定怎么解析
            return {'_raw': text, '_httpStatus': code}


def make_channel(kind, cfg):
    if kind == 'ftp':
        return FtpChannel(cfg)
    if kind == 'local':
        return LocalChannel(cfg)
    if kind == 'mes':
        return MesChannel(cfg)
    raise ChannelError('未知通道类型：%s' % kind)
