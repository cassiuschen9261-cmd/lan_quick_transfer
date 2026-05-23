param(
    [string]$Runtime = "",
    [ValidateSet("all", "smoke", "browser")]
    [string]$Target = "all"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-PreferredRuntime {
    param([string]$RequestedRuntime)

    if ($RequestedRuntime -and $RequestedRuntime -ne "node") {
        return $RequestedRuntime
    }

    $systemNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $systemNode) {
        return $systemNode
    }

    return "node"
}

function Assert-Node18OrLater {
    param([string]$RuntimeName)

    $versionOutput = & $RuntimeName -p "process.versions.node.split('.')[0]"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to detect the Node.js version."
    }

    $majorVersion = 0
    [void][int]::TryParse("$versionOutput", [ref]$majorVersion)
    if ($majorVersion -lt 18) {
        throw "Node.js 18 or later is required. Current major version: $majorVersion"
    }
}

function Invoke-RegressionScript {
    param(
        [string]$RuntimeName,
        [string]$ScriptName
    )

    Write-Host "Running $ScriptName ..."
    & $RuntimeName (Join-Path $projectRoot $ScriptName)
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$resolvedRuntime = Get-PreferredRuntime -RequestedRuntime $Runtime
Assert-Node18OrLater -RuntimeName $resolvedRuntime

Push-Location $projectRoot
try {
    switch ($Target) {
        "smoke" {
            Invoke-RegressionScript -RuntimeName $resolvedRuntime -ScriptName "test_standalone.js"
        }
        "browser" {
            Invoke-RegressionScript -RuntimeName $resolvedRuntime -ScriptName "test_browser_real.js"
        }
        default {
            Invoke-RegressionScript -RuntimeName $resolvedRuntime -ScriptName "test_standalone.js"
            Invoke-RegressionScript -RuntimeName $resolvedRuntime -ScriptName "test_browser_real.js"
        }
    }
} finally {
    Pop-Location
}
