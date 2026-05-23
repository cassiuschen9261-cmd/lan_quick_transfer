$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot "data"
$configPath = Join-Path $dataDir "server-config.json"
$statusPath = Join-Path $dataDir "server-status.json"

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

if (Test-Path $configPath) {
    try {
        $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Host "Configured bind host: $($config.host)"
        Write-Host "Configured port: $($config.port)"
    } catch {
        Write-Host "Configured bind host: unreadable"
        Write-Host "Configured port: unreadable"
    }
} else {
    Write-Host "Configured bind host: 0.0.0.0"
    Write-Host "Configured port: 18082"
}

Write-Host ""

if (-not (Test-Path $statusPath)) {
    Write-Host "Running state: stopped"
    Write-Host "No status file was found."
    exit 0
}

try {
    $status = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Host "Running state: unknown"
    Write-Host "Status file exists but could not be read."
    exit 1
}

if (-not $status.pid) {
    Write-Host "Running state: unknown"
    Write-Host "Status file did not contain a valid process id."
    exit 1
}

$isRunning = Test-ProcessAlive -PidValue ([int]$status.pid)
Write-Host ("Running state: " + ($(if ($isRunning) { "running" } else { "stopped" })))
Write-Host "Process ID: $($status.pid)"

if ($status.startedAt) {
    Write-Host "Started at: $($status.startedAt)"
}

if ($status.host) {
    Write-Host "Actual bind host: $($status.host)"
}

if ($status.port) {
    Write-Host "Actual port: $($status.port)"
}

if ($status.urls) {
    Write-Host "Available URLs:"
    foreach ($url in $status.urls) {
        Write-Host " - $url"
    }
}
