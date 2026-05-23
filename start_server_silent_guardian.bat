@echo off
setlocal EnableExtensions
title LAN Quick Transfer Silent Guardian
cd /d "%~dp0"

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "WSCRIPT_EXE=%SystemRoot%\System32\wscript.exe"
set "GUARDIAN_SCRIPT=%~dp0scripts\silent_guardian.ps1"

if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"
if not exist "%WSCRIPT_EXE%" set "WSCRIPT_EXE=wscript.exe"

if not exist "%GUARDIAN_SCRIPT%" (
    echo Missing helper script: "%GUARDIAN_SCRIPT%"
    exit /b 1
)

if /I "%~1"=="" goto START_HIDDEN
if /I "%~1"=="start" goto START_HIDDEN
if /I "%~1"=="runhidden" goto RUN_HIDDEN
if /I "%~1"=="install" goto INSTALL_ONLY
if /I "%~1"=="deploy" goto INSTALL_AND_START
if /I "%~1"=="uninstall" goto UNINSTALL_ONLY
if /I "%~1"=="remove" goto UNINSTALL_AND_STOP
if /I "%~1"=="stop" goto STOP_ONLY
if /I "%~1"=="status" goto SHOW_STATUS
if /I "%~1"=="menu" goto MENU
if /I "%~1"=="help" goto USAGE

goto USAGE

:START_HIDDEN
call :LAUNCH_HIDDEN Run
exit /b %ERRORLEVEL%

:RUN_HIDDEN
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%GUARDIAN_SCRIPT%" -Action Run
exit /b %ERRORLEVEL%

:INSTALL_ONLY
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%GUARDIAN_SCRIPT%" -Action Install
exit /b %ERRORLEVEL%

:INSTALL_AND_START
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%GUARDIAN_SCRIPT%" -Action Install
if errorlevel 1 exit /b %ERRORLEVEL%
call :LAUNCH_HIDDEN Run
exit /b %ERRORLEVEL%

:UNINSTALL_ONLY
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%GUARDIAN_SCRIPT%" -Action Uninstall
exit /b %ERRORLEVEL%

:UNINSTALL_AND_STOP
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%GUARDIAN_SCRIPT%" -Action Uninstall
if errorlevel 1 exit /b %ERRORLEVEL%
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%GUARDIAN_SCRIPT%" -Action Stop
exit /b %ERRORLEVEL%

:STOP_ONLY
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%GUARDIAN_SCRIPT%" -Action Stop
exit /b %ERRORLEVEL%

:SHOW_STATUS
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%GUARDIAN_SCRIPT%" -Action Status
exit /b %ERRORLEVEL%

:MENU
cls
echo =========================================
echo LAN Quick Transfer Silent Guardian
echo =========================================
echo 1. Start hidden guardian now
echo 2. Install startup entry only
echo 3. Install startup entry and start now
echo 4. Uninstall startup entry only
echo 5. Uninstall startup entry and stop all
echo 6. Stop guardian and server
echo 7. Show status
echo 8. Help
echo 9. Exit
echo.
set /p choice="Select 1-9: "

if "%choice%"=="1" goto START_HIDDEN
if "%choice%"=="2" goto INSTALL_ONLY
if "%choice%"=="3" goto INSTALL_AND_START
if "%choice%"=="4" goto UNINSTALL_ONLY
if "%choice%"=="5" goto UNINSTALL_AND_STOP
if "%choice%"=="6" goto STOP_ONLY
if "%choice%"=="7" goto SHOW_STATUS
if "%choice%"=="8" goto USAGE
if "%choice%"=="9" exit /b 0

echo Invalid choice.
echo.
pause
goto MENU

:LAUNCH_HIDDEN
set "TEMP_VBS=%TEMP%\lan_qt_guardian_%RANDOM%_%RANDOM%.vbs"
> "%TEMP_VBS%" echo Set shell = CreateObject("WScript.Shell")
>>"%TEMP_VBS%" echo shell.CurrentDirectory = "%~dp0"
>>"%TEMP_VBS%" echo shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%GUARDIAN_SCRIPT%"" -Action Run", 0, False
"%WSCRIPT_EXE%" "%TEMP_VBS%" >nul 2>nul
del /f /q "%TEMP_VBS%" >nul 2>nul
exit /b %ERRORLEVEL%

:USAGE
echo Usage:
echo   %~nx0                 Start hidden guardian immediately
echo   %~nx0 start           Start hidden guardian immediately
echo   %~nx0 install         Install current-user startup entry
echo   %~nx0 deploy          Install startup entry and start now
echo   %~nx0 uninstall       Remove current-user startup entry
echo   %~nx0 remove          Remove startup entry and stop guardian/server
echo   %~nx0 stop            Stop guardian and server
echo   %~nx0 status          Show guardian/server status
echo   %~nx0 menu            Open interactive menu
echo.
echo Log files are written to:
echo   "%~dp0data\logs"
exit /b 0
