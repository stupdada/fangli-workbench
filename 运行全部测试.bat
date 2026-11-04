@echo off
title GEO 内容工作台 - 全部测试
cd /d "%~dp0"

set "PY=python"
%PY% -V >nul 2>nul
if errorlevel 1 set "PY=py -3"

set "FAILED=0"
for %%F in (tools\test_*.py) do (
  echo.
  echo ------------------------------------------------------------
  echo   %%~nxF
  echo ------------------------------------------------------------
  %PY% "%%F"
  if errorlevel 1 set "FAILED=1"
)

echo.
echo ============================================================
if "%FAILED%"=="1" (
  echo   [X] 有测试未通过，往上翻看 FAIL 行
) else (
  echo   [OK] 全部测试通过
)
echo ============================================================
pause
