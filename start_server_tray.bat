@echo off
setlocal EnableExtensions
title LAN Quick Transfer Tray
cd /d "%~dp0"

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"

if not exist "scripts\tray_agent.ps1" (
    echo Missing tray agent: scripts\tray_agent.ps1
    pause
    exit /b 1
)

start "" "%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "scripts\tray_agent.ps1"
exit /b 0
