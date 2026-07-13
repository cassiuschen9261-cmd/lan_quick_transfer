# build_staging.ps1
# Assembles the install payload for the MSI and EXE installers.
param(
    [string]$ProjectRoot = "",
    [string]$OutDir = "",
    [string]$Version = "1.2.0"
)
$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot "build" }
$stagingRoot = Join-Path $OutDir "staging"
$appDir = Join-Path $stagingRoot "LANQuickTransfer"
Write-Host "==> Building staging directory: $appDir" -ForegroundColor Cyan
Write-Host "    ProjectRoot: $ProjectRoot" -ForegroundColor Gray
if (Test-Path $stagingRoot) { Remove-Item $stagingRoot -Recurse -Force }
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Write-Host "Copying application files..." -ForegroundColor Yellow
$appFiles = @("server.js","package.json","package-lock.json","qr-generator.min.js","start_server.bat","start_server.ps1","start_server_tray.bat","start_server_silent_guardian.bat","README.md","CHANGELOG.md","LICENSE","installer\wix\app.ico")
foreach ($file in $appFiles) {
    $src = Join-Path $ProjectRoot $file
    if (Test-Path $src) { Copy-Item $src -Destination $appDir -Force }
}
$htmlSrc = Join-Path $ProjectRoot "index.html"
if (Test-Path $htmlSrc) {
    Copy-Item $htmlSrc -Destination $appDir -Force
} else {
    $cnName = [char]0x8F7B + [char]0x91CF + [char]0x5C40 + [char]0x57DF + [char]0x7F51 + [char]0x5FEB + [char]0x4F20 + ".html"
    $cnSrc = Join-Path $ProjectRoot $cnName
    if (Test-Path $cnSrc) { Copy-Item $cnSrc -Destination (Join-Path $appDir "index.html") -Force }
}
$scriptsSrc = Join-Path $ProjectRoot "scripts"
if (Test-Path $scriptsSrc) { Copy-Item $scriptsSrc -Destination (Join-Path $appDir "scripts") -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $appDir "data") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $appDir "uploads") -Force | Out-Null
Write-Host "Copying portable Node.js runtime..." -ForegroundColor Yellow
$runtimeSrc = Join-Path $PSScriptRoot "runtime\extracted\PFiles64\nodejs"
$runtimeDest = Join-Path $appDir "runtime"
if (-not (Test-Path $runtimeSrc)) { throw "Portable Node.js not found at $runtimeSrc. Run extract_node.ps1 first." }
New-Item -ItemType Directory -Path $runtimeDest -Force | Out-Null
Copy-Item (Join-Path $runtimeSrc "node.exe") -Destination (Join-Path $runtimeDest "node.exe") -Force
Copy-Item (Join-Path $runtimeSrc "node_modules") -Destination (Join-Path $runtimeDest "node_modules") -Recurse -Force
foreach ($helper in @("npm","npm.cmd","npx","npx.cmd","npm.ps1","npx.ps1")) {
    $h = Join-Path $runtimeSrc $helper
    if (Test-Path $h) { Copy-Item $h -Destination $runtimeDest -Force }
}
Write-Host "Installing production dependencies into staging..." -ForegroundColor Yellow
Push-Location $appDir
try {
    & (Join-Path $runtimeDest "node.exe") (Join-Path $runtimeDest "node_modules\npm\bin\npm-cli.js") install --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed in staging" }
} finally { Pop-Location }
Write-Host "Creating runtime launchers..." -ForegroundColor Yellow
$launcherBat = Join-Path $appDir "launch_app.bat"
Set-Content $launcherBat -Value "@echo off`r`nsetlocal`r`ncd /d `"%~dp0`"`r`nset `"PATH=%~dp0runtime;%PATH%`"`r`nstart `"`" `"runtime\node.exe`" server.js`r`n" -NoNewline
$trayBat = Join-Path $appDir "launch_tray.bat"
Set-Content $trayBat -Value "@echo off`r`nsetlocal`r`ncd /d `"%~dp0`"`r`nset `"PATH=%~dp0runtime;%PATH%`"`r`nstart `"`" `"runtime\node.exe`" server.js tray`r`n" -NoNewline
"$Version" | Set-Content (Join-Path $appDir "VERSION") -NoNewline
$size = (Get-ChildItem $appDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host "Staging complete: $appDir" -ForegroundColor Green
Write-Host ("Size: {0:N1} MB" -f ($size/1MB)) -ForegroundColor Green
Write-Host ("File count: {0}" -f (Get-ChildItem $appDir -Recurse -File).Count) -ForegroundColor Green