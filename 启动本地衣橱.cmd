@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请安装 Node.js 22 或更新版本后再启动。
  if not defined WARDROBE_NO_PAUSE pause
  popd
  exit /b 1
)
node "scripts\start-local.mjs" %*
set "WARDROBE_EXIT=%ERRORLEVEL%"
if not "%WARDROBE_EXIT%"=="0" if not defined WARDROBE_NO_PAUSE pause
popd
exit /b %WARDROBE_EXIT%
