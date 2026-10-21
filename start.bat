@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装: https://nodejs.org
  pause
  exit /b 1
)
echo 正在启动码上取...
echo 启动后在浏览器打开 http://localhost:8000
echo 关闭本窗口即停止服务。
echo.
node server.js
pause
