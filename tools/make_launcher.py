# -*- coding: utf-8 -*-
"""生成 Windows 启动脚本：GBK 编码 + CRLF 换行（cmd 只认 CRLF），并做真实 Python 探测。"""

from pathlib import Path

BAT = """@echo off
title GEO 内容工作台
cd /d "%~dp0"

set "PY="
python -c "import sys;raise SystemExit(0 if sys.version_info>=(3,7) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=python"

if not defined PY (
  py -3 -c "import sys;raise SystemExit(0 if sys.version_info>=(3,7) else 1)" >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)

if not defined PY (
  echo.
  echo   [X] 没有找到可用的 Python 3.7 以上版本。
  echo.
  echo   请按下面步骤安装一次：
  echo     1. 打开 https://www.python.org/downloads/
  echo     2. 下载 Python 3.10 以上版本
  echo     3. 安装时务必勾选 "Add Python to PATH"
  echo     4. 装完重新双击本文件
  echo.
  echo   如果已经装过 Python，可能是被"应用商店占位程序"拦住了，
  echo   请在开始菜单搜索 "管理应用执行别名"，把 python.exe 和 python3.exe 关掉。
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================
echo    正在启动 GEO 内容工作台，请稍等...
echo    启动后浏览器会自动打开
echo    这个窗口不要关闭，关掉就退出程序
echo   ============================================
echo.

%PY% app\\server.py

echo.
echo   程序已退出。按任意键关闭窗口。
pause >nul
"""

if __name__ == "__main__":
    p = Path(__file__).resolve().parent.parent / "启动.bat"
    data = BAT.replace("\n", "\r\n").encode("gbk")
    p.write_bytes(data)
    print("已生成:", p, len(data), "字节")
