param(
    [ValidateSet("enable", "disable", "status")]
    [string]$Action = "status"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$valueName = "LanQuickTransfer"
$launcherPath = Join-Path $PSScriptRoot "startup_silent_launcher.vbs"
$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
if (-not (Test-Path $wscriptPath)) {
    $wscriptPath = "wscript.exe"
}

$commandValue = '"' + $wscriptPath + '" "' + $launcherPath + '"'

function Show-Status {
    $current = Get-ItemProperty -Path $runKey -Name $valueName -ErrorAction SilentlyContinue
    if ($null -eq $current) {
        Write-Host "Auto start: disabled"
        Write-Host "Registry value not found."
        return
    }

    Write-Host "Auto start: enabled"
    Write-Host "Registry name: $valueName"
    Write-Host "Command: $($current.$valueName)"
}

switch ($Action) {
    "enable" {
        if (-not (Test-Path $launcherPath)) {
            Write-Host "startup_silent_launcher.vbs was not found."
            exit 1
        }

        New-ItemProperty -Path $runKey -Name $valueName -Value $commandValue -PropertyType String -Force | Out-Null
        Write-Host "Auto start enabled."
        Write-Host "Registry name: $valueName"
        Write-Host "Command: $commandValue"
    }
    "disable" {
        Remove-ItemProperty -Path $runKey -Name $valueName -ErrorAction SilentlyContinue
        Write-Host "Auto start disabled."
    }
    "status" {
        Show-Status
    }
}
