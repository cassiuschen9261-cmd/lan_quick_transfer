param(
    [switch]$OpenDownloadPage
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$minimumMajorVersion = 18
$downloadUrl = "https://nodejs.org/en/download"
$localInstallerDirs = @(
    (Join-Path $projectRoot "tools\nodejs"),
    (Join-Path $projectRoot "runtime\nodejs")
)

function Test-Node18OrLater {
    param([string]$NodePath)

    if (-not $NodePath) {
        return $false
    }

    try {
        $majorText = & $NodePath -p "process.versions.node.split('.')[0]" 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $false
        }
        $major = 0
        if (-not [int]::TryParse("$majorText", [ref]$major)) {
            return $false
        }
        return ($major -ge $minimumMajorVersion)
    } catch {
        return $false
    }
}

function Get-InstalledNodePath {
    $candidates = @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
        "node"
    )

    foreach ($candidate in $candidates) {
        if (-not $candidate) {
            continue
        }
        if ($candidate -eq "node") {
            $command = Get-Command node -ErrorAction SilentlyContinue
            if ($command -and (Test-Node18OrLater -NodePath $command.Source)) {
                return $command.Source
            }
        } elseif ((Test-Path $candidate) -and (Test-Node18OrLater -NodePath $candidate)) {
            return $candidate
        }
    }

    return ""
}

function Get-LocalNodeInstaller {
    foreach ($dir in $localInstallerDirs) {
        if (-not (Test-Path $dir)) {
            continue
        }

        $installer = Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^node-v(18|19|20|21|22|23|24)\..*-(x64|x86)\.msi$' } |
            Sort-Object Name -Descending |
            Select-Object -First 1

        if ($installer) {
            return $installer.FullName
        }
    }

    return ""
}

function Install-FromLocalMsi {
    param([string]$InstallerPath)

    Write-Host "Found local Node.js installer: $InstallerPath"
    Write-Host "Installing Node.js 18+ from local MSI..."
    $process = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $InstallerPath, "/passive", "/norestart") -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Local Node.js installer failed with exit code $($process.ExitCode)."
    }
}

function Install-FromWinget {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        return $false
    }

    Write-Host "Installing Node.js LTS with winget..."
    $arguments = @(
        "install",
        "--id", "OpenJS.NodeJS.LTS",
        "--exact",
        "--accept-package-agreements",
        "--accept-source-agreements"
    )
    $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -eq 0) {
        return $true
    }

    Write-Host "winget install failed with exit code $($process.ExitCode)."
    return $false
}

function Open-NodeDownloadPage {
    Write-Host "Opening Node.js download page: $downloadUrl"
    Start-Process $downloadUrl | Out-Null
}

$existingNode = Get-InstalledNodePath
if ($existingNode) {
    Write-Host "Node.js 18+ is already available: $existingNode"
    exit 0
}

if ($OpenDownloadPage) {
    Open-NodeDownloadPage
    exit 1
}

$localInstaller = Get-LocalNodeInstaller
if ($localInstaller) {
    Install-FromLocalMsi -InstallerPath $localInstaller
} else {
    $installedByWinget = Install-FromWinget
    if (-not $installedByWinget) {
        Write-Host "Automatic installation could not be completed."
        Write-Host "If you want offline installation, put the Node.js Windows MSI into tools\nodejs, then run this installer again."
        Open-NodeDownloadPage
        exit 1
    }
}

$installedNode = Get-InstalledNodePath
if (-not $installedNode) {
    Write-Host "Node.js installation finished, but Node.js 18+ was not detected in this session."
    Write-Host "If the installer completed successfully, close this window and run start_server.bat again."
    exit 1
}

Write-Host "Node.js 18+ is ready: $installedNode"
exit 0
