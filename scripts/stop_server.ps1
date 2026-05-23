$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$statusPath = Join-Path $projectRoot "data\server-status.json"

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

if (-not (Test-Path $statusPath)) {
    Write-Host "No server status file was found."
    Write-Host "If the server was started manually, stop that window directly."
    exit 0
}

try {
    $status = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Remove-Item $statusPath -Force -ErrorAction SilentlyContinue
    Write-Host "The status file was invalid and has been removed."
    exit 0
}

if (-not $status.pid) {
    Remove-Item $statusPath -Force -ErrorAction SilentlyContinue
    Write-Host "The status file did not contain a valid process id."
    exit 0
}

$pidValue = [int]$status.pid
if (-not (Test-ProcessAlive -PidValue $pidValue)) {
    Remove-Item $statusPath -Force -ErrorAction SilentlyContinue
    Write-Host "Server process $pidValue is not running anymore."
    exit 0
}

Stop-Process -Id $pidValue -Force
Start-Sleep -Milliseconds 700
Remove-Item $statusPath -Force -ErrorAction SilentlyContinue

Write-Host "Server process $pidValue has been stopped."
