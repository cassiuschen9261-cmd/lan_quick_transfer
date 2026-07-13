# generate_wix_fragment.ps1
# Walks the staging directory and generates a WiX fragment (harvest.wxs)
# containing all Directory, Component, and File elements.
param(
    [string]$StagingDir = (Join-Path $PSScriptRoot "build\staging\LANQuickTransfer"),
    [string]$OutFile = (Join-Path $PSScriptRoot "wix\harvest.wxs")
)
$ErrorActionPreference = "Stop"
$stagingRoot = $StagingDir
if (-not (Test-Path $stagingRoot)) { throw "Staging dir not found: $stagingRoot" }

# Ensure wix output dir
$wixDir = Split-Path -Parent $OutFile
if (-not (Test-Path $wixDir)) { New-Item -ItemType Directory -Path $wixDir -Force | Out-Null }

$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine("<?xml version=`"1.0`" encoding=`"UTF-8`"?>")
[void]$sb.AppendLine("<Wix xmlns=`"http://wixtoolset.org/schemas/v4/wxs`">")
[void]$sb.AppendLine("  <Fragment>")
[void]$sb.AppendLine("    <DirectoryRef Id=`"INSTALLFOLDER`">")

$dirIdCounter = 0
$fileIdCounter = 0
$componentIds = [System.Collections.Generic.List[string]]::new()

function Sanitize-Id($name) {
    $id = $name -replace '[^A-Za-z0-9_.]', '_'
    if ($id -match '^[0-9]') { $id = "_$id" }
    return $id
}

function Emit-Directory($path, $relativePath, $indent) {
    $dirName = Split-Path $path -Leaf
    $dirId = "dir_$($script:dirIdCounter)"
    $script:dirIdCounter++
    [void]$script:sb.AppendLine("${indent}<Directory Id=`"$dirId`" Name=`"$dirName`">")
    
    # Emit files in this directory
    $files = Get-ChildItem $path -File -Force | Sort-Object Name
    foreach ($file in $files) {
        $fileId = "file_$($script:fileIdCounter)"
        $script:fileIdCounter++
        $compId = "comp_$($script:fileIdCounter)"
        $script:componentIds.Add($compId)
        $relFile = $file.FullName.Substring($script:stagingRoot.Length + 1)
        $relFile = $relFile -replace '\\','\\'
        [void]$script:sb.AppendLine("${indent}  <Component Id=`"$compId`" Guid=`"$([guid]::NewGuid().ToString().ToUpper())`">")
        [void]$script:sb.AppendLine("${indent}    <File Id=`"$fileId`" Name=`"$($file.Name)`" Source=`"$( $file.FullName )`" KeyPath=`"yes`" />")
        [void]$script:sb.AppendLine("${indent}  </Component>")
    }
    
    # Recurse into subdirectories
    $subdirs = Get-ChildItem $path -Directory -Force | Sort-Object Name
    foreach ($subdir in $subdirs) {
        Emit-Directory $subdir.FullName ($subdir.FullName.Substring($script:stagingRoot.Length)) ($indent + "  ")
    }
    
    [void]$script:sb.AppendLine("${indent}</Directory>")
}

# Walk top-level subdirectories of staging
$topDirs = Get-ChildItem $stagingRoot -Directory -Force | Sort-Object Name
foreach ($dir in $topDirs) {
    Emit-Directory $dir.FullName "" "      "
}

# Also emit top-level files
$topFiles = Get-ChildItem $stagingRoot -File -Force | Sort-Object Name
foreach ($file in $topFiles) {
    $fileId = "file_$($script:fileIdCounter)"
    $script:fileIdCounter++
    $compId = "comp_$($script:fileIdCounter)"
    $script:componentIds.Add($compId)
    [void]$script:sb.AppendLine("      <Component Id=`"$compId`" Guid=`"$([guid]::NewGuid().ToString().ToUpper())`">")
    [void]$script:sb.AppendLine("        <File Id=`"$fileId`" Name=`"$($file.Name)`" Source=`"$($file.FullName)`" KeyPath=`"yes`" />")
    [void]$script:sb.AppendLine("      </Component>")
}

[void]$sb.AppendLine("    </DirectoryRef>")
[void]$sb.AppendLine("  </Fragment>")
[void]$sb.AppendLine("  <Fragment>")

# ComponentGroup referencing all components for the Feature
[void]$sb.AppendLine("    <ComponentGroup Id=`"AppFiles`">")
foreach ($cid in $componentIds) {
    [void]$sb.AppendLine("      <ComponentRef Id=`"$cid`" />")
}
[void]$sb.AppendLine("    </ComponentGroup>")
[void]$sb.AppendLine("  </Fragment>")
[void]$sb.AppendLine("</Wix>")

$utf8Bom = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText($OutFile, $sb.ToString(), $utf8Bom)
Write-Host "Generated: $OutFile" -ForegroundColor Green
Write-Host ("Components: {0}" -f $componentIds.Count) -ForegroundColor Green