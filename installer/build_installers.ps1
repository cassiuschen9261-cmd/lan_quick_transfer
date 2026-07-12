# build_installers.ps1
# End-to-end build: extract Node runtime -> stage payload -> build MSI + EXE
param(
    [string]$Version = "1.1.0",
    [switch]$SkipExtract
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  LAN Quick Transfer - Installer Builder" -ForegroundColor Cyan
Write-Host "  Version: $Version" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Step 1: Extract portable Node.js (skip if already done)
$nodeExe = Join-Path $here "runtime\extracted\PFiles64\nodejs\node.exe"
if (-not $SkipExtract -or -not (Test-Path $nodeExe)) {
    Write-Host ""
    Write-Host "[1/4] Extracting portable Node.js runtime..." -ForegroundColor Yellow
    & (Join-Path $here "extract_node.ps1")
} else {
    Write-Host ""
    Write-Host "[1/4] Portable Node.js already extracted, skipping." -ForegroundColor Gray
}

# Step 2: Build staging directory
Write-Host ""
Write-Host "[2/4] Building staging directory..." -ForegroundColor Yellow
& (Join-Path $here "build_staging.ps1") -Version $Version

# Step 3: Build MSI
Write-Host ""
Write-Host "[3/4] Building MSI installer..." -ForegroundColor Yellow
$wix = Join-Path $env:USERPROFILE ".dotnet\tools\wix.exe"
$msiOut = Join-Path $here "build\LANQuickTransfer-$Version.msi"
& $wix build -arch x64 `
    (Join-Path $here "wix\product.wxs") `
    (Join-Path $here "wix\harvest.wxs") `
    -ext "WixToolset.UI.wixext" `
    -out $msiOut
if ($LASTEXITCODE -ne 0) { throw "MSI build failed" }
Write-Host "MSI: $msiOut" -ForegroundColor Green

# Step 4: Build EXE
Write-Host ""
Write-Host "[4/4] Building EXE installer..." -ForegroundColor Yellow
$iscc = Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"
& $iscc (Join-Path $here "LANQuickTransfer.iss")
if ($LASTEXITCODE -ne 0) { throw "EXE build failed" }

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Build complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Get-ChildItem (Join-Path $here "build") -Filter "LANQuickTransfer-*" | ForEach-Object {
    Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length/1MB)) -ForegroundColor White
}