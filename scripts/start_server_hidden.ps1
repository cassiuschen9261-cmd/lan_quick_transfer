param(
    [string]$Runtime = "node"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot "data"
$statusPath = Join-Path $dataDir "server-status.json"

function Get-PreferredRuntime {
    param(
        [string]$RequestedRuntime
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

$Runtime = Get-PreferredRuntime -RequestedRuntime $Runtime
$NpmCommand = Get-PreferredNpm -ResolvedRuntime $Runtime

if (-not (Get-Command $Runtime -ErrorAction SilentlyContinue)) {
    Write-Host "Runtime '$Runtime' was not found."
    exit 1
}

if (-not (Test-NodeVersion -RuntimeName $Runtime)) {
    Write-Host "Node.js 18 or later is required."
    exit 1
}

if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}

if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
    Write-Host "Installing dependencies..."
    & $NpmCommand install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Dependency installation failed."
        exit $LASTEXITCODE
    }
}

if (Test-Path $statusPath) {
    try {
        $existingStatus = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($existingStatus.pid -and (Test-ProcessAlive -PidValue ([int]$existingStatus.pid))) {
            Write-Host "Server is already running in background."
            if ($existingStatus.urls) {
                Write-Host "Available URLs:"
                foreach ($url in $existingStatus.urls) {
                    Write-Host " - $url"
                }
            }
            exit 0
        }
    } catch {
    }

    Remove-Item $statusPath -Force -ErrorAction SilentlyContinue
}

$process = Start-Process -FilePath $Runtime -ArgumentList "server.js" -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

if (-not (Test-ProcessAlive -PidValue $process.Id)) {
    Write-Host "Silent background mode failed to start."
    exit 1
}

Write-Host "Server started in silent background mode."
Write-Host "Process ID: $($process.Id)"

for ($i = 0; $i -lt 5; $i++) {
    if (Test-Path $statusPath) {
        try {
            $status = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($status.urls) {
                Write-Host "Available URLs:"
                foreach ($url in $status.urls) {
                    Write-Host " - $url"
                }
            }
            break
        } catch {
        }
    }

    Start-Sleep -Milliseconds 500
}
