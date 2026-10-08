"""Double-click launcher for the SQLite desktop edition.

The HTML remains the UI. This process owns the local HTTP server and the
SQLite file, so users do not need to start a separate bridge window.
"""
import argparse
import os
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser


ROOT = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
DATA_ROOT = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else ROOT
BRIDGE = os.path.join(ROOT, 'bridge', 'lava_bridge.py')
HTML = os.path.join(ROOT, 'LavaTestBoard.html')
if not os.path.isfile(HTML):
    HTML = os.path.join(ROOT, 'Lava_test看板.html')


def wait_port(port, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.3):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def main():
    if '--bridge-server' in sys.argv:
        sys.argv.remove('--bridge-server')
        # The frozen executable reuses the bundled bridge module in a child
        # process; this avoids trying to execute a .py file with an EXE.
        sys.path.insert(0, os.path.join(ROOT, 'bridge'))
        import lava_bridge
        return lava_bridge.main()
        return 0
    ap = argparse.ArgumentParser(description='Lava_test SQLite desktop launcher')
    ap.add_argument('--port', type=int, default=8770)
    ap.add_argument('--browser', action='store_true', help='use the default browser instead of pywebview')
    ap.add_argument('--database', default=os.path.join(DATA_ROOT, 'data', 'lava_test.sqlite3'))
    args = ap.parse_args()
    if not os.path.isfile(HTML):
        raise SystemExit('找不到构建产物，请先运行 node build.js')
    if getattr(sys, 'frozen', False):
        cmd = [sys.executable, '--bridge-server']
    else:
        cmd = [sys.executable, BRIDGE]
    cmd += ['--port', str(args.port), '--web-root', ROOT,
           '--database', os.path.abspath(args.database)]
    creationflags = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    proc = subprocess.Popen(cmd, cwd=ROOT, creationflags=creationflags)
    if not wait_port(args.port):
        proc.terminate()
        raise SystemExit('SQLite 服务启动失败，请检查 Python 环境或端口占用')
    url = 'http://127.0.0.1:%d/' % args.port
    try:
        if not args.browser:
            try:
                import webview
                webview.create_window('Lava_test 硬盘测试数据看板', url,
                                      width=1440, height=900, min_size=(1100, 700))
                webview.start()
            except ImportError:
                webbrowser.open(url)
                proc.wait()
        else:
            webbrowser.open(url)
            proc.wait()
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
    return 0


if __name__ == '__main__':
    sys.exit(main())
