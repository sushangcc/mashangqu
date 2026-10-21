# 快递码集合 —— 开机自启运行器（由任务计划程序调用，隐藏窗口启动服务）
# 注意：不要手动运行本文件，请运行 tools/install-autostart.ps1 注册任务

$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location $projectDir
Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $projectDir -WindowStyle Hidden
