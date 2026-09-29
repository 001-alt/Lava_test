# -*- coding: utf-8 -*-
"""
只读守卫与访问控制
============================================================================
桥接服务是浏览器与现场设备之间的唯一通道，必须保证**只读**：

  1. 端点白名单 —— 只有注册过的路由可访问，其余一律 404
  2. 路径白名单 —— 文件操作只能落在配置允许的根目录内，杜绝 ../ 穿越
  3. SSH 命令白名单 —— 只允许 ls / cat / find / df 这类读命令，
     任何写操作（rm / mv / dd / echo > / tee）直接拒绝
  4. 令牌校验 —— 非本机访问必须带 X-Bridge-Token

「只读」不是保守，是产线红线：桥接跑在有测试程序在跑的机器旁边，
任何误写都可能影响正在测的盘。
"""

import os
import hmac
import ipaddress

# ---------------------------------------------------------------------------
# SSH 命令白名单：前缀匹配。只放读操作。
# ---------------------------------------------------------------------------
READONLY_COMMANDS = (
    'ls', 'cat', 'head', 'tail', 'find', 'df', 'du', 'stat', 'wc',
    'grep', 'zgrep', 'zcat', 'unzip -l', 'ps', 'uptime', 'whoami',
    'hostname', 'uname', 'date', 'test', 'mount', 'lsblk', 'free',
)

# 明确禁止的写法（即使命令本身在白名单里，带这些也算写操作）
FORBIDDEN_PATTERNS = (
    '>', '>>', '| tee', ' rm ', ' mv ', ' cp ', ' dd ', ' mkfs',
    'chmod', 'chown', 'kill', 'reboot', 'shutdown', 'systemctl',
    'service ', 'crontab', 'sudo', 'su ', 'passwd', 'useradd', 'userdel',
    'truncate', 'sed -i', 'apt', 'yum', 'pip install', 'touch',
)


class ForbiddenOperation(Exception):
    """请求了非只读操作"""
    pass


def check_command(cmd):
    """校验 SSH 命令是否只读。不通过则抛 ForbiddenOperation。"""
    c = str(cmd or '').strip()
    if not c:
        raise ForbiddenOperation('命令为空')

    low = ' ' + c.lower() + ' '
    for pat in FORBIDDEN_PATTERNS:
        if pat in low:
            raise ForbiddenOperation('命令含写操作特征，已拒绝：%r' % pat.strip())

    head = c.split()[0]
    for allowed in READONLY_COMMANDS:
        if c.lower().startswith(allowed):
            return c
    raise ForbiddenOperation('命令不在只读白名单内：%s' % head)


def safe_join(root, rel):
    """
    把 rel 拼到 root 下，并确保结果仍在 root 内。
    防的是 ../../etc/passwd 这类路径穿越。
    """
    if not root:
        raise ForbiddenOperation('未配置根目录')

    root_abs = os.path.realpath(root)
    # 绝对路径直接拒绝：一律按相对路径处理
    rel = str(rel or '').replace('\\', '/').lstrip('/')
    target = os.path.realpath(os.path.join(root_abs, rel))

    if target != root_abs and not target.startswith(root_abs + os.sep):
        raise ForbiddenOperation('路径越界，已拒绝：%s' % rel)
    return target


def in_allowed_roots(path, roots):
    """路径是否落在任一允许的根目录下"""
    if not roots:
        return False
    p = os.path.realpath(path)
    for r in roots:
        ra = os.path.realpath(r)
        if p == ra or p.startswith(ra + os.sep):
            return True
    return False


class AccessControl(object):
    """令牌 + 来源地址校验"""

    def __init__(self, token='', allow_remote=False):
        self.token = (token or '').strip()
        self.allow_remote = bool(allow_remote)

    def check(self, client_addr, provided_token):
        """
        返回 (ok, reason)
        本机请求免令牌；非本机必须带正确令牌，且需显式开启远程访问。
        """
        ip = (client_addr or '').split(':')[0]
        is_local = False
        try:
            addr = ipaddress.ip_address(ip)
            is_local = addr.is_loopback
        except ValueError:
            is_local = ip in ('localhost', '')

        if is_local:
            return True, ''

        if not self.allow_remote:
            return False, '桥接仅允许本机访问。如需远程，启动时加 --allow-remote 并配置 token'

        if not self.token:
            return False, '未配置 token，远程访问已禁用'

        if not provided_token or not hmac.compare_digest(str(provided_token), self.token):
            return False, '令牌不正确'
        return True, ''
