"""Fangli local workbench entry point; never mounts the native ZIP write server."""
import argparse
import json
import os
import sys
import threading
import webbrowser
from pathlib import Path
sys.dont_write_bytecode = True
from bridge.http import create_server
from bridge.errors import Problem


def main():
    parser = argparse.ArgumentParser(description='方立内容工作台（仅本机）')
    parser.add_argument('--port', type=int, default=8770)
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parent / 'data/workbench')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--video-base', help=argparse.SUPPRESS)
    args = parser.parse_args()
    server = None
    try:
        server = create_server(args.data_dir / 'workbench.db', args.port, args.video_base)
        video = server.video.start()
    except (Problem, OSError):
        if server: server.server_close()
        print('无法启动完整工作台：请检查端口、数据目录、Node/Python/Pillow及私有视频日志。', file=sys.stderr, flush=True)
        return 1
    url = f'http://127.0.0.1:{server.server_port}'
    print(json.dumps({'type': 'ready', 'port': server.server_port, 'pid': os.getpid(), 'url': url, 'video': video}, ensure_ascii=False), flush=True)
    if not args.no_browser:
        threading.Timer(.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
