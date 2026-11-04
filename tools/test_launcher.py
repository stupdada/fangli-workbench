# -*- coding: utf-8 -*-
"""启动脚本测试：验证 双击 启动.bat 能真正把服务拉起来。

检查项
1. 编码与换行：必须是 GBK + CRLF（cmd 只认 CRLF，LF 会导致什么都不执行）
2. 双击等价的启动过程：能拉起服务并对外提供接口
3. 首页与静态资源可访问
4. 关闭窗口后端口释放

用法：python tools/test_launcher.py
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
BAT = BASE / "启动.bat"
PORT = 8791
URL = f"http://127.0.0.1:{PORT}"

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name + (("  -> " + detail) if detail and not ok else ""))


def http(path, timeout=3):
    req = urllib.request.Request(URL + path)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def port_open(port):
    s = socket.socket()
    s.settimeout(0.5)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def kill_tree(pid):
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                   capture_output=True, shell=False)


def main():
    os.environ["no_proxy"] = "127.0.0.1,localhost"
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"

    print("\n[1] 启动脚本文件本身")
    if not BAT.exists():
        print("  [失败] 找不到 启动.bat")
        return 1
    raw = BAT.read_bytes()
    crlf = raw.count(b"\r\n")
    lone_lf = raw.count(b"\n") - crlf
    check("文件存在", True)
    check("使用 CRLF 换行（LF 会导致 cmd 不执行任何命令）", lone_lf == 0, f"存在 {lone_lf} 个孤立 LF")
    check("行数正常", crlf >= 20, f"仅 {crlf} 行")
    try:
        text = raw.decode("gbk")
        check("GBK 编码（中文提示不乱码）", True)
    except UnicodeDecodeError:
        text = ""
        check("GBK 编码（中文提示不乱码）", False, "无法按 GBK 解码")
    check("无 UTF-8 BOM（BOM 会让首行 @echo off 失效）", not raw.startswith(b"\xef\xbb\xbf"))
    check("调用 app\\server.py", "app\\server.py" in text)
    check("失败时停住窗口（含 pause）", "pause" in text)

    print("\n[2] 模拟双击启动")
    if port_open(PORT):
        print(f"  [失败] 端口 {PORT} 已被占用，无法测试")
        return 1
    env = dict(os.environ)
    env["GEO_PORT"] = str(PORT)
    env["GEO_NO_BROWSER"] = "1"
    proc = subprocess.Popen(["cmd", "/c", str(BAT)], cwd=str(BASE), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        t0 = time.time()
        ok = False
        first_err = ""
        while time.time() - t0 < 25:
            try:
                st, _ = http("/api/bootstrap", timeout=1.5)
                if st == 200:
                    ok = True
                    break
            except Exception as e:
                if not first_err:
                    first_err = type(e).__name__
            time.sleep(0.4)
        waited = time.time() - t0
        check("双击后服务自动起来（25 秒内）", ok, f"等了 {waited:.1f} 秒仍无响应 {first_err}")
        if not ok:
            return 1

        print(f"       启动耗时 {waited:.1f} 秒")
        check("启动过程是真实冷启动（不是复用了残留进程）", waited > 0.05, f"耗时 {waited:.3f}s")

        st, body = http("/api/bootstrap")
        d = json.loads(body)
        check("接口返回正常", d.get("ok") is True)
        # 用户可能自己增删平台，这里只要求至少预置的 6 个还在
        check("数据已初始化（平台至少 6 个）", len(d.get("platforms", [])) >= 6,
              str(len(d.get("platforms", []))))
        check("风险清单已预填（不空白）", len(d.get("risks", [])) >= 40,
              str(len(d.get("risks", []))))

        st, html = http("/")
        page = html.decode("utf-8", "ignore")
        check("首页能打开", st == 200 and "GEO 内容工作台" in page)
        st, js = http("/static/app.js")
        check("前端脚本能加载", st == 200 and len(js) > 10000, str(len(js)))
        st, css = http("/static/styles.css")
        check("样式能加载", st == 200 and len(css) > 5000, str(len(css)))

        print("\n[3] 重复启动会被拦住")
        dup = subprocess.run([sys.executable, str(BASE / "app" / "server.py"), "--no-browser"],
                             cwd=str(BASE), env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, timeout=30)
        try:
            out = dup.stdout.decode("utf-8")
        except UnicodeDecodeError:
            out = dup.stdout.decode("gbk", "ignore")
        check("第二个进程自己退出（不再另起一个写同一个库）", dup.returncode == 0,
              f"退出码 {dup.returncode}")
        check("明确提示已经在运行", "已经在运行" in out, out[-300:])
        try:
            st2, _ = http("/api/bootstrap")
            check("原实例仍在正常服务", st2 == 200)
        except Exception:
            check("原实例仍在正常服务", False)

        print("\n[4] 关闭窗口后释放端口")
    finally:
        kill_tree(proc.pid)
        time.sleep(1.5)

    check("进程已结束，端口释放", not port_open(PORT))

    print("\n" + "=" * 46)
    print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
    if failed:
        for n, dd in failed:
            print("  失败：" + n + ("  " + dd if dd else ""))
        print("结果：不通过")
        return 1
    print("结果：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
