# LAN Quick Transfer - Installer Packaging

This directory contains scripts and configuration to build Windows MSI and EXE
installers for LAN Quick Transfer. Both installers bundle a **portable Node.js
runtime** and **production dependencies**, so end users need nothing pre-installed.

## Prerequisites

- .NET SDK 9+ (for WiX Toolset v7)
- WiX Toolset v7: `dotnet tool install --global wix`
- Accept WiX EULA: `wix eula accept wix7`
- WiX UI extension: `wix extension add WixToolset.UI.wixext`
- Inno Setup 6 (install via `winget install JRSoftware.InnoSetup`)
- Node.js MSI at `tools/nodejs/node-v22.23.0-x64.msi`

## Build

```powershell
# Full build: extract node, stage, build MSI + EXE
powershell -File installer\build_installers.ps1 -Version 1.1.0

# Or step by step:
powershell -File installer\extract_node.ps1
powershell -File installer\build_staging.ps1 -Version 1.1.0
powershell -File installer\generate_wix_fragment.ps1
# MSI:
wix build -arch x64 installer\wix\product.wxs installer\wix\harvest.wxs -ext WixToolset.UI.wixext -out installer\build\LANQuickTransfer-1.1.0.msi
# EXE:
"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" installer\LANQuickTransfer.iss
```

## Output

- `installer/build/LANQuickTransfer-1.1.0.msi` - MSI installer
- `installer/build/LANQuickTransfer-1.1.0-setup.exe` - EXE installer

## What the installers include

- Application files (server.js, frontend HTML, scripts, launchers)
- Portable Node.js 22 runtime (no system Node.js required)
- Production node_modules (express, cors, multer)
- Start Menu shortcuts (normal + tray mode)
- Optional desktop shortcut
- Add/Remove Programs uninstall entry

## Files

| File | Purpose |
|------|---------|
| `extract_node.ps1` | Extracts portable Node.js from the bundled MSI |
| `build_staging.ps1` | Assembles the install payload into `build/staging/` |
| `generate_wix_fragment.ps1` | Harvests staging dir into WiX XML (`wix/harvest.wxs`) |
| `wix/product.wxs` | WiX product definition (MSI structure, shortcuts, UI) |
| `wix/app.ico` | Application icon |
| `LANQuickTransfer.iss` | Inno Setup script (EXE installer) |
| `build_installers.ps1` | End-to-end build orchestrator |

## Directory layout (gitignored)

```
installer/
  runtime/extracted/    # extracted portable Node.js (gitignored)
  build/staging/        # assembled payload (gitignored)
  build/*.msi           # built MSI (gitignored)
  build/*.exe           # built EXE (gitignored)
```