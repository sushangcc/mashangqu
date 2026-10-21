# 注意：本文件必须保存为 UTF-8 with BOM（PowerShell 5.1 依赖 BOM 识别 UTF-8）
# 若无 BOM，Windows PowerShell 会按 GBK 解析，导致中文乱码与语法错误
# 快递码集合 —— 系统托盘启动器
# 双击运行可显示托盘图标；开机时由启动项自动调用

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectDir = Split-Path -Parent $PSScriptRoot
$port = 8000
$url = "http://localhost:$port"

# 单实例：已在运行则退出
$mutex = New-Object System.Threading.Mutex($false, 'Global\KuaidimaTray')
if (-not $mutex.WaitOne(0)) { exit }

function Test-Server {
    try {
        $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/health" -TimeoutSec 2 -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Start-Server {
    if (Test-Server) { return $true }
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $projectDir -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Server) { return $true }
    }
    return $false
}

function Stop-Server {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 400
}

# 图标：优先用项目图标，失败则用系统图标
$iconPath = Join-Path $projectDir 'public\icons\icon-192.png'
$icon = [System.Drawing.SystemIcons]::Application
if (Test-Path $iconPath) {
    try {
        $bmp = [System.Drawing.Bitmap]::FromFile($iconPath)
        $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
        $icon = $ico
    } catch { }
}

# 托盘图标
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = '快递码集合'
$notify.Visible = $true

# 右键菜单
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '打开网页'
$itemOpen.Font = New-Object System.Drawing.Font($itemOpen.Font, [System.Drawing.FontStyle]::Bold)
$itemOpen.Add_Click({ Start-Process $url })
[void]$menu.Items.Add($itemOpen)

$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '状态：检测中…'
$itemStatus.Enabled = $false
[void]$menu.Items.Add($itemStatus)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '重启服务'
$itemRestart.Add_Click({
    $itemRestart.Enabled = $false
    $notify.Text = '快递码集合 · 正在重启…'
    Stop-Server
    Start-Server | Out-Null
    $itemRestart.Enabled = $true
    $notify.ShowBalloonTip(2000, '快递码集合', '服务已重启', [System.Windows.Forms.ToolTipIcon]::Info)
})
[void]$menu.Items.Add($itemRestart)

$itemStop = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '停止服务'
$itemStop.Add_Click({
    Stop-Server
    $notify.ShowBalloonTip(2000, '快递码集合', '服务已停止', [System.Windows.Forms.ToolTipIcon]::Warning)
})
[void]$menu.Items.Add($itemStop)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '退出（并停止服务）'
$itemExit.Add_Click({
    Stop-Server
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($itemExit)

$notify.ContextMenuStrip = $menu

# 左键单击 → 打开网页
$notify.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Start-Process $url
    }
})

# 定时刷新状态
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
    if (Test-Server) {
        $itemStatus.Text = '状态：运行中 ●'
        $itemStatus.ForeColor = [System.Drawing.Color]::FromArgb(29, 117, 57)
        $notify.Text = "快递码集合 · 运行中`n$url"
    } else {
        $itemStatus.Text = '状态：已停止 ○'
        $itemStatus.ForeColor = [System.Drawing.Color]::FromArgb(207, 52, 57)
        $notify.Text = '快递码集合 · 已停止'
    }
})
$timer.Start()

# 启动时确保服务在跑
Start-Server | Out-Null
if (Test-Server) {
    $notify.ShowBalloonTip(2500, '快递码集合已就绪', "$url`n口令见 data\token.txt", [System.Windows.Forms.ToolTipIcon]::Info)
} else {
    $notify.ShowBalloonTip(3000, '快递码集合启动失败', '请右键托盘图标 → 重启服务', [System.Windows.Forms.ToolTipIcon]::Error)
}

# 消息循环
[System.Windows.Forms.Application]::Run()
