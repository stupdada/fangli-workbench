@echo off
chcp 65001 >nul
setlocal
title 方立内容工作台
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "FANGLI_PY="
python -c "import sys;raise SystemExit(0 if sys.version_info>=(3,10) else 1)" >nul 2>nul
if not errorlevel 1 set "FANGLI_PY=python"
if not defined FANGLI_PY (
  py -3 -c "import sys;raise SystemExit(0 if sys.version_info>=(3,10) else 1)" >nul 2>nul
  if not errorlevel 1 set "FANGLI_PY=py -3"
)
if not defined FANGLI_PY (
  echo 请安装 Python 3.10 或以上版本，并加入 PATH。
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)" >nul 2>nul
if errorlevel 1 (
  echo 请安装 Node.js 20 或以上版本，并加入 PATH。
  pause
  exit /b 1
)
echo 正在启动方立内容工作台，服务窗口请保持打开。
%FANGLI_PY% main.py
echo 工作台已退出。
pause