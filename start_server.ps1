param(
    [string]$Runtime = "node"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

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

Write-Host "Starting LAN Quick Transfer..."
$Runtime = Get-PreferredRuntime -RequestedRuntime $Runtime
$NpmCommand = Get-PreferredNpm -ResolvedRuntime $Runtime

if (-not (Get-Command $Runtime -ErrorAction SilentlyContinue)) {
    Write-Host "Runtime '$Runtime' was not found. Please install Node.js first."
    Read-Host "Press Enter to exit"
    exit 1
}

if (-not (Test-NodeVersion -RuntimeName $Runtime)) {
    Write-Host "Node.js 18 or later is required."
    Write-Host "Please upgrade Node.js, then run this launcher again."
    Read-Host "Press Enter to exit"
    exit 1
}

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
    Write-Host "Installing dependencies..."
    & $NpmCommand install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Dependency installation failed."
        Read-Host "Press Enter to exit"
        exit $LASTEXITCODE
    }
}

Write-Host "Launching server..."
& $Runtime server.js
$exitCode = $LASTEXITCODE

if ($null -eq $exitCode) {
    $exitCode = 0
}

Write-Host ""
Write-Host "Server stopped with exit code $exitCode."
Read-Host "Press Enter to exit"
exit $exitCode
