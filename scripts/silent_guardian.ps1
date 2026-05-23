param(
    [ValidateSet("Run", "Install", "Uninstall", "Status", "Stop")]
    [string]$Action = "Status"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot "data"
$logsDir = Join-Path $dataDir "logs"
$statusPath = Join-Path $dataDir "server-status.json"
$guardianStatePath = Join-Path $dataDir "guardian-status.json"
$stopFlagPath = Join-Path $dataDir "guardian-stop.flag"
$startupFolder = [Environment]::GetFolderPath("Startup")
$startupFileName = "LAN Quick Transfer Silent Guardian.vbs"
$startupFilePath = Join-Path $startupFolder $startupFileName
$batchLauncherPath = Join-Path $projectRoot "start_server_silent_guardian.bat"
$nodeScriptPath = Join-Path $projectRoot "server.js"
$stopServerScript = Join-Path $PSScriptRoot "stop_server.ps1"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$legacyRunValueName = "LanQuickTransfer"
$serverProbeTimeoutSeconds = 20
$guardianProbeIntervalSeconds = 15
$logRetentionDays = 7
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path $windowsPowerShell)) {
    $windowsPowerShell = "powershell.exe"
}

function Ensure-Directory {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-GuardianLogPath {
    Ensure-Directory -Path $logsDir
    return (Join-Path $logsDir ("guardian-{0}.log" -f (Get-Date -Format "yyyyMMdd")))
}

function Get-ServerLogPath {
    Ensure-Directory -Path $logsDir
    return (Join-Path $logsDir ("server-{0}.log" -f (Get-Date -Format "yyyyMMdd")))
}

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR")]
        [string]$Level = "INFO",
        [switch]$Console
    )

    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Add-Content -LiteralPath (Get-GuardianLogPath) -Value $line -Encoding UTF8
    if ($Console) {
        Write-Host $line
    }
}

function Write-LoggedError {
    param(
        [System.Management.Automation.ErrorRecord]$ErrorRecord
    )

    $message = $ErrorRecord.Exception.Message
    if ($ErrorRecord.ScriptStackTrace) {
        $message = "{0} | Stack: {1}" -f $message, $ErrorRecord.ScriptStackTrace
    }
    Write-Log -Message $message -Level "ERROR"
}

function Read-JsonFile {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    try {
        return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        Write-Log -Message ("Failed to parse JSON file: {0}" -f $Path) -Level "WARN"
        return $null
    }
}

function Test-ProcessAlive {
    param(
        [int]$PidValue
    )

    try {
        Get-Process -Id $PidValue -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-PreferredRuntime {
    param(
        [string]$RequestedRuntime = "node"
    )

    if ($RequestedRuntime -and $RequestedRuntime -ne "node") {
        return $RequestedRuntime
    }

    $systemNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $systemNode) {
        return $systemNode
    }

    return "node"
}

function Get-PreferredNpm {
    param(
        [string]$ResolvedRuntime
    )

    if ($ResolvedRuntime -and $ResolvedRuntime -ne "node") {
        $runtimeDir = Split-Path -Parent $ResolvedRuntime
        $npmCandidate = Join-Path $runtimeDir "npm.cmd"
        if (Test-Path $npmCandidate) {
            return $npmCandidate
        }
    }

    return "npm"
}

function Test-NodeVersion {
    param(
        [string]$RuntimeName
    )

    $major = & $RuntimeName -p "process.versions.node.split('.')[0]"
    if ($LASTEXITCODE -ne 0) {
        return $false
    }

    return ([int]$major -ge 18)
}

function Cleanup-OldLogs {
    Ensure-Directory -Path $logsDir
    $cutoff = (Get-Date).AddDays(-$logRetentionDays)

    Get-ChildItem -LiteralPath $logsDir -Filter "*.log" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
}

function Remove-LegacyRegistryStartup {
    Remove-ItemProperty -Path $runKey -Name $legacyRunValueName -ErrorAction SilentlyContinue
}

function Remove-DuplicateStartupEntries {
    Ensure-Directory -Path $startupFolder
    $scriptMarkers = @(
        $batchLauncherPath,
        (Join-Path $PSScriptRoot "silent_guardian.ps1"),
        "LAN Quick Transfer Silent Guardian"
    )

    $wshShell = $null
    try {
        $wshShell = New-Object -ComObject WScript.Shell
    } catch {
    }

    Get-ChildItem -LiteralPath $startupFolder -File -ErrorAction SilentlyContinue | ForEach-Object {
        $item = $_
        $shouldRemove = $false
        $extension = $item.Extension.ToLowerInvariant()

        if ($item.FullName -ieq $startupFilePath) {
            $shouldRemove = $true
        } elseif ($extension -in @(".vbs", ".cmd", ".bat", ".ps1")) {
            try {
                $content = Get-Content -LiteralPath $item.FullName -Raw -Encoding UTF8
                foreach ($marker in $scriptMarkers) {
                    if ($content -like "*$marker*") {
                        $shouldRemove = $true
                        break
                    }
                }
            } catch {
            }
        } elseif ($extension -eq ".lnk" -and $null -ne $wshShell) {
            try {
                $shortcut = $wshShell.CreateShortcut($item.FullName)
                $targetText = "{0} {1}" -f $shortcut.TargetPath, $shortcut.Arguments
                foreach ($marker in $scriptMarkers) {
                    if ($targetText -like "*$marker*") {
                        $shouldRemove = $true
                        break
                    }
                }
            } catch {
            }
        }

        if ($shouldRemove) {
            Remove-Item -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue
            Write-Log -Message ("Removed duplicate startup entry: {0}" -f $item.FullName)
        }
    }
}

function Get-StartupVbsContent {
    $escapedProjectRoot = $projectRoot.Replace('"', '""')
    $escapedScriptPath = (Join-Path $PSScriptRoot "silent_guardian.ps1").Replace('"', '""')
    return @"
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$escapedProjectRoot"
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$escapedScriptPath"" -Action Run", 0, False
"@
}

function Get-GuardianState {
    $guardianState = Read-JsonFile -Path $guardianStatePath
    if ($null -eq $guardianState) {
        return $null
    }

    if ($guardianState.pid -and (Test-ProcessAlive -PidValue ([int]$guardianState.pid))) {
        return $guardianState
    }

    Remove-Item -LiteralPath $guardianStatePath -Force -ErrorAction SilentlyContinue
    return $null
}

function Save-GuardianState {
    Ensure-Directory -Path $dataDir
    $state = @{
        pid = $PID
        startedAt = (Get-Date).ToString("o")
        batchLauncher = $batchLauncherPath
        startupEntry = $startupFilePath
        computerName = $env:COMPUTERNAME
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath $guardianStatePath -Encoding UTF8
}

function Remove-StaleServerStatus {
    $status = Read-JsonFile -Path $statusPath
    if ($null -eq $status) {
        return
    }

    if (-not $status.pid) {
        Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue
        return
    }

    if (-not (Test-ProcessAlive -PidValue ([int]$status.pid))) {
        Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-ServerStatus {
    Remove-StaleServerStatus
    return (Read-JsonFile -Path $statusPath)
}

function Test-ServerRunning {
    $status = Get-ServerStatus
    return ($null -ne $status -and $status.pid -and (Test-ProcessAlive -PidValue ([int]$status.pid)))
}

function Resolve-Environment {
    $runtime = Get-PreferredRuntime
    $npmCommand = Get-PreferredNpm -ResolvedRuntime $runtime

    if (-not (Get-Command $runtime -ErrorAction SilentlyContinue)) {
        throw "Runtime '$runtime' was not found. Please install Node.js first."
    }

    if (-not (Test-NodeVersion -RuntimeName $runtime)) {
        throw "Node.js 18 or later is required."
    }

    return @{
        Runtime = $runtime
        NpmCommand = $npmCommand
    }
}

function Ensure-Dependencies {
    param(
        [hashtable]$EnvironmentInfo
    )

    $nodeModules = Join-Path $projectRoot "node_modules"
    if (Test-Path $nodeModules) {
        return
    }

    Write-Log -Message "Installing project dependencies."
    Push-Location $projectRoot
    try {
        & $EnvironmentInfo.NpmCommand install *>> (Get-GuardianLogPath)
        if ($LASTEXITCODE -ne 0) {
            throw "Dependency installation failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

function Start-ServerProcess {
    if (Test-ServerRunning) {
        Write-Log -Message "Server is already running."
        return $true
    }

    $environmentInfo = Resolve-Environment
    Ensure-Dependencies -EnvironmentInfo $environmentInfo
    Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue

    $logPath = Get-ServerLogPath
    $escapedProjectRoot = $projectRoot.Replace("'", "''")
    $escapedRuntime = $environmentInfo.Runtime.Replace("'", "''")
    $escapedNodeScriptPath = $nodeScriptPath.Replace("'", "''")
    $escapedLogPath = $logPath.Replace("'", "''")
    $launchCommand = "& { Set-Location -LiteralPath '$escapedProjectRoot'; & '$escapedRuntime' '$escapedNodeScriptPath' *>> '$escapedLogPath' }"

    $bootstrapProcess = Start-Process -FilePath $windowsPowerShell `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $launchCommand) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -PassThru

    Write-Log -Message ("Started hidden bootstrap process. PID: {0}" -f $bootstrapProcess.Id)

    for ($second = 0; $second -lt $serverProbeTimeoutSeconds; $second++) {
        Start-Sleep -Seconds 1
        $status = Get-ServerStatus
        if ($null -ne $status -and $status.pid -and (Test-ProcessAlive -PidValue ([int]$status.pid))) {
            $urls = @()
            if ($status.urls) {
                $urls = @($status.urls)
            }
            if ($urls.Count -gt 0) {
                Write-Log -Message ("Server reported ready URLs: {0}" -f ($urls -join ", "))
            } else {
                Write-Log -Message ("Server reported ready on port {0}." -f $status.port)
            }
            return $true
        }

        if ($bootstrapProcess.HasExited -and $bootstrapProcess.ExitCode -ne 0) {
            break
        }
    }

    Write-Log -Message "Server did not report healthy status before timeout." -Level "ERROR"
    return $false
}

function Install-StartupEntry {
    Ensure-Directory -Path $dataDir
    Ensure-Directory -Path $startupFolder
    Cleanup-OldLogs
    Remove-LegacyRegistryStartup
    Remove-DuplicateStartupEntries

    New-Item -ItemType File -Path $startupFilePath -Force | Out-Null
    Set-Content -Path $startupFilePath -Value (Get-StartupVbsContent) -Encoding ASCII
    Write-Log -Message ("Startup entry installed: {0}" -f $startupFilePath) -Console
}

function Uninstall-StartupEntry {
    Ensure-Directory -Path $startupFolder
    Cleanup-OldLogs
    Remove-LegacyRegistryStartup
    Remove-DuplicateStartupEntries
    if (Test-Path $startupFilePath) {
        Remove-Item -LiteralPath $startupFilePath -Force -ErrorAction SilentlyContinue
    }
    Write-Log -Message ("Startup entry removed: {0}" -f $startupFilePath) -Console
}

function Stop-GuardianAndServer {
    Ensure-Directory -Path $dataDir
    Set-Content -LiteralPath $stopFlagPath -Value ((Get-Date).ToString("o")) -Encoding ASCII

    if (Test-Path $stopServerScript) {
        & $stopServerScript *>> (Get-GuardianLogPath)
    }

    $guardianState = Get-GuardianState
    if ($guardianState -and $guardianState.pid -and ([int]$guardianState.pid -ne $PID)) {
        Start-Sleep -Seconds 2
        if (Test-ProcessAlive -PidValue ([int]$guardianState.pid)) {
            Stop-Process -Id ([int]$guardianState.pid) -Force -ErrorAction SilentlyContinue
            Write-Log -Message ("Guardian process stopped. PID: {0}" -f $guardianState.pid)
        }
    }

    Remove-Item -LiteralPath $guardianStatePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stopFlagPath -Force -ErrorAction SilentlyContinue
    Write-Log -Message "Stop command completed." -Console
}

function Show-Status {
    Cleanup-OldLogs
    $guardianState = Get-GuardianState
    $serverStatus = Get-ServerStatus

    Write-Host ("Startup entry: {0}" -f $(if (Test-Path $startupFilePath) { "installed" } else { "not installed" }))
    Write-Host ("Startup file: {0}" -f $startupFilePath)
    Write-Host ("Guardian state: {0}" -f $(if ($guardianState) { "running" } else { "stopped" }))
    if ($guardianState) {
        Write-Host ("Guardian PID: {0}" -f $guardianState.pid)
        Write-Host ("Guardian started at: {0}" -f $guardianState.startedAt)
    }
    Write-Host ("Server state: {0}" -f $(if (Test-ServerRunning) { "running" } else { "stopped" }))
    if ($serverStatus) {
        Write-Host ("Server PID: {0}" -f $serverStatus.pid)
        if ($serverStatus.port) {
            Write-Host ("Server port: {0}" -f $serverStatus.port)
        }
        if ($serverStatus.urls) {
            Write-Host "Server URLs:"
            foreach ($url in @($serverStatus.urls)) {
                Write-Host (" - {0}" -f $url)
            }
        }
    }
    Write-Host ("Guardian log: {0}" -f (Get-GuardianLogPath))
    Write-Host ("Server log: {0}" -f (Get-ServerLogPath))
}

function Run-GuardianLoop {
    Ensure-Directory -Path $dataDir
    Cleanup-OldLogs
    Remove-Item -LiteralPath $stopFlagPath -Force -ErrorAction SilentlyContinue

    $existingGuardian = Get-GuardianState
    if ($existingGuardian -and ([int]$existingGuardian.pid -ne $PID)) {
        Write-Log -Message ("Guardian is already running. PID: {0}" -f $existingGuardian.pid)
        return
    }

    Save-GuardianState
    Write-Log -Message "Guardian loop started."

    try {
        if (-not (Start-ServerProcess)) {
            Write-Log -Message "Initial server launch failed. Guardian will continue monitoring." -Level "WARN"
        }

        $lastCleanupAt = Get-Date
        while ($true) {
            if (Test-Path $stopFlagPath) {
                Write-Log -Message "Stop flag detected. Guardian will exit."
                break
            }

            if (-not (Test-ServerRunning)) {
                Write-Log -Message "Server process is not running. Restarting now." -Level "WARN"
                [void](Start-ServerProcess)
            }

            if (((Get-Date) - $lastCleanupAt).TotalHours -ge 12) {
                Cleanup-OldLogs
                $lastCleanupAt = Get-Date
            }

            Start-Sleep -Seconds $guardianProbeIntervalSeconds
        }
    } finally {
        $currentState = Get-GuardianState
        if ($currentState -and ([int]$currentState.pid -eq $PID)) {
            Remove-Item -LiteralPath $guardianStatePath -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $stopFlagPath -Force -ErrorAction SilentlyContinue
        Write-Log -Message "Guardian loop stopped."
    }
}

try {
    switch ($Action) {
        "Run" {
            Run-GuardianLoop
        }
        "Install" {
            Install-StartupEntry
        }
        "Uninstall" {
            Uninstall-StartupEntry
        }
        "Status" {
            Show-Status
        }
        "Stop" {
            Stop-GuardianAndServer
        }
    }
} catch {
    Write-LoggedError -ErrorRecord $_
    if ($Action -ne "Run") {
        Write-Host ("Error: {0}" -f $_.Exception.Message)
        Write-Host ("See guardian log: {0}" -f (Get-GuardianLogPath))
    }
    exit 1
}
