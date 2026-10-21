# 快递码集合 —— 注册 Windows 开机自启（当前用户登录时，隐藏窗口启动服务）
# 用法：在 PowerShell 中执行本脚本；或右键 → 使用 PowerShell 运行
# 卸载：powershell -ExecutionPolicy Bypass -File ".\tools\install-autostart.ps1" -Uninstall

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$taskName = 'KuaidiCodeCollection'
$projectDir = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $projectDir 'tools\autostart-run.ps1'

if ($Uninstall) {
    schtasks /delete /tn $taskName /f | Out-Null
    Write-Host "已删除开机自启任务 $taskName"
    exit 0
}

if (-not (Test-Path $runner)) {
    Write-Host "[错误] 未找到 $runner" -ForegroundColor Red
    exit 1
}

# 若已存在旧任务则先删除
schtasks /query /tn $taskName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    schtasks /delete /tn $taskName /f | Out-Null
    Write-Host '已移除旧任务'
}

$tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
schtasks /create /tn $taskName /tr $tr /sc onlogon /rl limited /f | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host '[错误] 创建任务失败，请尝试以管理员身份运行 PowerShell' -ForegroundColor Red
    exit 1
}

Write-Host '[完成] 开机自启已注册：登录 Windows 后会自动隐藏启动快递码集合服务' -ForegroundColor Green
Write-Host ('服务地址: http://localhost:8000   口令: 见 ' + (Join-Path $projectDir 'data\token.txt'))
Write-Host '卸载: powershell -ExecutionPolicy Bypass -File ".\tools\install-autostart.ps1" -Uninstall'
