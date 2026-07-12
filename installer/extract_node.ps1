# extract_node.ps1
# Extracts a portable Node.js runtime from the bundled MSI into installer/runtime/extracted/
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$msi = Join-Path $here "..\tools\nodejs\node-v22.23.0-x64.msi"
if (-not (Test-Path $msi)) { throw "Node.js MSI not found: $msi" }
$extractDir = Join-Path $here "runtime\extracted"
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
Write-Host "Extracting Node.js MSI to: $extractDir" -ForegroundColor Cyan
$proc = Start-Process msiexec -ArgumentList "/a `"$msi`" /qn TARGETDIR=`"$extractDir`"" -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0) { throw "MSI extraction failed with exit code $($proc.ExitCode)" }
Start-Sleep -Seconds 2
$nodeExe = Join-Path $extractDir "PFiles64\nodejs\node.exe"
if (-not (Test-Path $nodeExe)) { throw "node.exe not found after extraction at $nodeExe" }
$ver = & $nodeExe --version
Write-Host "Portable Node.js ready: $ver" -ForegroundColor Green
Write-Host "Location: $nodeExe" -ForegroundColor Green