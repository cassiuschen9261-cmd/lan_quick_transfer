Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot "data"
$statusPath = Join-Path $dataDir "server-status.json"
$guardianStatePath = Join-Path $dataDir "guardian-status.json"
$startupFolder = [Environment]::GetFolderPath("Startup")
$startupFilePath = Join-Path $startupFolder "LAN Quick Transfer Silent Guardian.vbs"
$silentGuardianScript = Join-Path $PSScriptRoot "silent_guardian.ps1"
$statusPanelPath = Join-Path $PSScriptRoot "server_status.hta"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$legacyRunValueName = "LanQuickTransfer"
$powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$mshtaPath = Join-Path $env:SystemRoot "System32\mshta.exe"
$createdNew = $false
$trayMutex = New-Object System.Threading.Mutex($true, "Local\LANQuickTransferTrayAgent", [ref]$createdNew)

if (-not $createdNew) {
    exit 0
}

if (-not (Test-Path $powerShellPath)) {
    $powerShellPath = "powershell.exe"
}
if (-not (Test-Path $mshtaPath)) {
    $mshtaPath = "mshta.exe"
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-ProcessAlive {
    param([int]$PidValue)
    try {
        Get-Process -Id $PidValue -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-ServerStatus {
    $status = Read-JsonFile -Path $statusPath
    if ($null -eq $status -or -not $status.pid) {
        return $null
    }
    if (-not (Test-ProcessAlive -PidValue ([int]$status.pid))) {
        Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue
        return $null
    }
    return $status
}

function Get-GuardianStatusText {
    $guardianState = Read-JsonFile -Path $guardianStatePath
    if ($null -ne $guardianState -and $guardianState.pid -and (Test-ProcessAlive -PidValue ([int]$guardianState.pid))) {
        return "守护进程：运行中"
    }
    return "守护进程：未运行"
}

function Test-StartupEnabled {
    if (Test-Path $startupFilePath) {
        return $true
    }
    $legacyValue = Get-ItemProperty -Path $runKey -Name $legacyRunValueName -ErrorAction SilentlyContinue
    return ($null -ne $legacyValue)
}

function Get-StartupStatusText {
    if (Test-StartupEnabled) {
        return "开机自启：已启用"
    }
    return "开机自启：未启用"
}

function Get-PreferredUrl {
    $status = Get-ServerStatus
    if ($null -eq $status -or -not $status.urls) {
        return ""
    }
    $urls = @($status.urls)
    $lanUrl = $urls | Where-Object { $_ -notmatch "127\.0\.0\.1|localhost" } | Select-Object -First 1
    if ($lanUrl) {
        return [string]$lanUrl
    }
    return [string]($urls | Select-Object -First 1)
}

function Get-ServerStatusText {
    $status = Get-ServerStatus
    if ($null -eq $status) {
        return "服务：未运行"
    }
    return "服务：运行中 端口 $($status.port)"
}

function Show-Balloon {
    param(
        [string]$Title,
        [string]$Text,
        [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
    )
    $notifyIcon.BalloonTipTitle = $Title
    $notifyIcon.BalloonTipText = $Text
    $notifyIcon.BalloonTipIcon = $Icon
    $notifyIcon.ShowBalloonTip(2500)
}

function Start-GuardianHidden {
    Start-Process -FilePath $powerShellPath -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $silentGuardianScript, "-Action", "Run") -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
    Show-Balloon -Title "LAN Quick Transfer" -Text "正在后台启动服务..."
}

function Stop-GuardianAndServer {
    Start-Process -FilePath $powerShellPath -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $silentGuardianScript, "-Action", "Stop") -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait | Out-Null
    Show-Balloon -Title "LAN Quick Transfer" -Text "后台服务已停止"
}

function Set-StartupState {
    param([bool]$Enabled)
    $action = if ($Enabled) { "Install" } else { "Uninstall" }
    Start-Process -FilePath $powerShellPath -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $silentGuardianScript, "-Action", $action) -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait | Out-Null
    $text = if ($Enabled) { "开机自启已启用" } else { "开机自启已关闭" }
    Show-Balloon -Title "LAN Quick Transfer" -Text $text
}

function Open-QuickUrl {
    $url = Get-PreferredUrl
    if (-not $url) {
        Show-Balloon -Title "LAN Quick Transfer" -Text "服务未运行，暂无可打开地址" -Icon ([System.Windows.Forms.ToolTipIcon]::Warning)
        return
    }
    Start-Process $url | Out-Null
}

function Copy-QuickUrl {
    $url = Get-PreferredUrl
    if (-not $url) {
        Show-Balloon -Title "LAN Quick Transfer" -Text "服务未运行，暂无可复制地址" -Icon ([System.Windows.Forms.ToolTipIcon]::Warning)
        return
    }
    [System.Windows.Forms.Clipboard]::SetText($url)
    Show-Balloon -Title "LAN Quick Transfer" -Text "快连地址已复制：$url"
}

function Open-StatusPanel {
    if (Test-Path $statusPanelPath) {
        Start-Process -FilePath $mshtaPath -ArgumentList @($statusPanelPath) -WorkingDirectory $projectRoot | Out-Null
    }
}

function Refresh-Menu {
    $serverText.Text = Get-ServerStatusText
    $guardianText.Text = Get-GuardianStatusText
    $startupText.Text = Get-StartupStatusText
    $url = Get-PreferredUrl
    if ($url) {
        $urlText.Text = "快连地址：$url"
        $openItem.Enabled = $true
        $copyItem.Enabled = $true
    } else {
        $urlText.Text = "快连地址：暂无"
        $openItem.Enabled = $false
        $copyItem.Enabled = $false
    }
    $enableStartupItem.Enabled = -not (Test-StartupEnabled)
    $disableStartupItem.Enabled = Test-StartupEnabled
    $notifyIcon.Text = "LAN Quick Transfer - $(Get-ServerStatusText)"
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Visible = $true
$notifyIcon.Text = "LAN Quick Transfer"

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$serverText = New-Object System.Windows.Forms.ToolStripMenuItem
$serverText.Enabled = $false
$guardianText = New-Object System.Windows.Forms.ToolStripMenuItem
$guardianText.Enabled = $false
$startupText = New-Object System.Windows.Forms.ToolStripMenuItem
$startupText.Enabled = $false
$urlText = New-Object System.Windows.Forms.ToolStripMenuItem
$urlText.Enabled = $false
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem("打开快连页面")
$copyItem = New-Object System.Windows.Forms.ToolStripMenuItem("复制快连地址")
$startItem = New-Object System.Windows.Forms.ToolStripMenuItem("启动/守护后台服务")
$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem("停止后台服务")
$enableStartupItem = New-Object System.Windows.Forms.ToolStripMenuItem("启用开机自启")
$disableStartupItem = New-Object System.Windows.Forms.ToolStripMenuItem("关闭开机自启")
$statusPanelItem = New-Object System.Windows.Forms.ToolStripMenuItem("打开状态面板")
$refreshItem = New-Object System.Windows.Forms.ToolStripMenuItem("刷新状态")
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem("退出托盘")

[void]$menu.Items.Add($serverText)
[void]$menu.Items.Add($guardianText)
[void]$menu.Items.Add($startupText)
[void]$menu.Items.Add($urlText)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add($copyItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($startItem)
[void]$menu.Items.Add($stopItem)
[void]$menu.Items.Add($enableStartupItem)
[void]$menu.Items.Add($disableStartupItem)
[void]$menu.Items.Add($statusPanelItem)
[void]$menu.Items.Add($refreshItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($exitItem)

$menu.add_Opening({ Refresh-Menu })
$openItem.add_Click({ Open-QuickUrl })
$copyItem.add_Click({ Copy-QuickUrl })
$startItem.add_Click({ Start-GuardianHidden })
$stopItem.add_Click({ Stop-GuardianAndServer })
$enableStartupItem.add_Click({ Set-StartupState -Enabled $true })
$disableStartupItem.add_Click({ Set-StartupState -Enabled $false })
$statusPanelItem.add_Click({ Open-StatusPanel })
$refreshItem.add_Click({ Refresh-Menu })
$exitItem.add_Click({ $notifyIcon.Visible = $false; $notifyIcon.Dispose(); $trayMutex.ReleaseMutex(); $trayMutex.Dispose(); [System.Windows.Forms.Application]::Exit() })
$notifyIcon.add_DoubleClick({ Open-QuickUrl })

$notifyIcon.ContextMenuStrip = $menu
Refresh-Menu
Start-GuardianHidden
Show-Balloon -Title "LAN Quick Transfer" -Text "托盘已启动。右键图标可管理后台服务。"
[System.Windows.Forms.Application]::Run()
