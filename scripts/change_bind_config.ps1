param(
    [switch]$ResetDefault,
    [string]$HostValue,
    [int]$PortValue
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot "data"
$configPath = Join-Path $dataDir "server-config.json"

function Get-DefaultConfig {
    return @{
        host = "0.0.0.0"
        port = 18082
    }
}

function Get-ReplacementPort {
    param(
        [int]$PortValue
    )

    if ($PortValue -in @(18080, 18081)) {
        return 18082
    }

    return $PortValue
}

function Test-BindHost {
    param(
        [string]$HostValue
    )

    if ([string]::IsNullOrWhiteSpace($HostValue)) {
        return $false
    }

    $trimmed = $HostValue.Trim()
    if ($trimmed -in @("0.0.0.0", "127.0.0.1", "localhost")) {
        return $true
    }

    return $trimmed -match '^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$'
}

function Load-Config {
    if (-not (Test-Path $dataDir)) {
        New-Item -ItemType Directory -Path $dataDir | Out-Null
    }

    if (-not (Test-Path $configPath)) {
        $defaults = Get-DefaultConfig
        Save-Config -Config $defaults
        return $defaults
    }

    try {
        $raw = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $host = if (Test-BindHost $raw.host) { $raw.host.Trim() } else { "0.0.0.0" }
        $port = 18082
        if ($raw.port -as [int]) {
            $portCandidate = Get-ReplacementPort -PortValue ([int]$raw.port)
            if ($portCandidate -ge 1 -and $portCandidate -le 65535) {
                $port = $portCandidate
            }
        }

        $config = @{
            host = $host
            port = $port
        }

        Save-Config -Config $config
        return $config
    } catch {
        $defaults = Get-DefaultConfig
        Save-Config -Config $defaults
        return $defaults
    }
}

function Save-Config {
    param(
        [hashtable]$Config
    )

    if (-not (Test-Path $dataDir)) {
        New-Item -ItemType Directory -Path $dataDir | Out-Null
    }

    $payload = @{}
    if (Test-Path $configPath) {
        try {
            $existing = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
            if ($existing) {
                $payload = $existing
            }
        } catch {
        }
    }

    foreach ($entry in $Config.GetEnumerator()) {
        $payload[$entry.Key] = $entry.Value
    }

    $payload | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8
}

if ($ResetDefault) {
    $defaults = Get-DefaultConfig
    Save-Config -Config $defaults
    Write-Host "Bind host reset to $($defaults.host)"
    Write-Host "Port reset to $($defaults.port)"
    exit 0
}

$current = Load-Config

if ($PSBoundParameters.ContainsKey("HostValue") -or $PSBoundParameters.ContainsKey("PortValue")) {
    $newHost = if ([string]::IsNullOrWhiteSpace($HostValue)) { $current.host } else { $HostValue.Trim() }
    if (-not (Test-BindHost $newHost)) {
        Write-Host "Invalid bind host. Nothing was changed."
        exit 1
    }

    $newPort = if ($PSBoundParameters.ContainsKey("PortValue")) { $PortValue } else { [int]$current.port }
    $newPort = Get-ReplacementPort -PortValue $newPort
    if ($newPort -lt 1 -or $newPort -gt 65535) {
        Write-Host "Invalid port. Nothing was changed."
        exit 1
    }

    if ($PSBoundParameters.ContainsKey("PortValue") -and $PortValue -in @(18080, 18081)) {
        Write-Host "Port $PortValue is reserved. It was changed automatically to $newPort."
    }

    $updated = @{
        host = $newHost
        port = $newPort
    }

    Save-Config -Config $updated
    Write-Host "Saved successfully."
    Write-Host "Bind host: $($updated.host)"
    Write-Host "Port: $($updated.port)"
    exit 0
}

Write-Host "Current bind host: $($current.host)"
Write-Host "Current port: $($current.port)"
Write-Host ""
Write-Host "Examples:"
Write-Host " - 0.0.0.0    listen on all network adapters"
Write-Host " - 127.0.0.1  local computer only"
Write-Host " - 192.168.1.8 specific LAN IP only"
Write-Host ""

$hostInput = Read-Host "Enter new bind host (press Enter to keep current)"
if ([string]::IsNullOrWhiteSpace($hostInput)) {
    $newHost = $current.host
} else {
    $newHost = $hostInput.Trim()
    if (-not (Test-BindHost $newHost)) {
        Write-Host "Invalid bind host. Nothing was changed."
        exit 1
    }
}

$portInput = Read-Host "Enter new port 1-65535 (press Enter to keep current, 18080/18081 will auto-change)"
if ([string]::IsNullOrWhiteSpace($portInput)) {
    $newPort = [int]$current.port
} elseif ($portInput -match '^\d+$') {
    $rawPortCandidate = [int]$portInput
    $portCandidate = Get-ReplacementPort -PortValue $rawPortCandidate
    if ($portCandidate -lt 1 -or $portCandidate -gt 65535) {
        Write-Host "Invalid port. Nothing was changed."
        exit 1
    }
    $newPort = $portCandidate
    if ($rawPortCandidate -in @(18080, 18081)) {
        Write-Host "Port $rawPortCandidate is reserved. It was changed automatically to $newPort."
    }
} else {
    Write-Host "Invalid port. Nothing was changed."
    exit 1
}

$updated = @{
    host = $newHost
    port = $newPort
}

Save-Config -Config $updated

Write-Host ""
Write-Host "Saved successfully."
Write-Host "Bind host: $($updated.host)"
Write-Host "Port: $($updated.port)"
