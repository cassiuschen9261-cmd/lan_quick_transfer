# create_icon.ps1 - generates a minimal 16x16 ICO
$bmpSize = 40 + 16*16*4
$iconDir = [byte[]]@(0,0,1,0,1,0)
$entry = [byte[]]@(16,16,0,0,1,0,32,0) + [BitConverter]::GetBytes([uint32]$bmpSize) + [BitConverter]::GetBytes([uint32]22)
$header = [BitConverter]::GetBytes([uint32]40) + [BitConverter]::GetBytes([int32]16) + [BitConverter]::GetBytes([int32]32) + [BitConverter]::GetBytes([uint16]1) + [BitConverter]::GetBytes([uint16]32) + [BitConverter]::GetBytes([uint32]0) + [BitConverter]::GetBytes([uint32](16*16*4)) + [byte[]]@(0,0,0,0,0,0,0,0)
$pixels = [byte[]]::new(16*16*4)
for ($y = 0; $y -lt 16; $y++) {
    for ($x = 0; $x -lt 16; $x++) {
        $idx = ($y * 16 + $x) * 4
        $pixels[$idx] = 180
        $pixels[$idx+1] = 90
        $pixels[$idx+2] = 30
        $pixels[$idx+3] = 255
    }
}
$andMask = [byte[]]::new(16*4)
$allBytes = $iconDir + $entry + $header + $pixels + $andMask
$out = Join-Path $PSScriptRoot "app.ico"
[System.IO.File]::WriteAllBytes($out, $allBytes)
Write-Host "ICO created: $((Get-Item $out).Length) bytes at $out"