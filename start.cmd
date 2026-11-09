@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 node，请先安装 Node.js 18+ 或使用 DSH 桌面端自带的 node。
  pause
  exit /b 1
)

if not exist "web\data\plugins.json" (
  echo 正在生成插件目录...
  rem 内网无网络：--offline 保证不发任何请求
  node scripts\build-catalog.mjs --offline
)

node server.mjs
pause
