@echo off
setlocal
title LAN Quick Transfer Launcher
cd /d "%~dp0"

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "MSHTA_EXE=%SystemRoot%\System32\mshta.exe"
set "WSCRIPT_EXE=%SystemRoot%\System32\wscript.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"
if not exist "%MSHTA_EXE%" set "MSHTA_EXE=mshta.exe"
if not exist "%WSCRIPT_EXE%" set "WSCRIPT_EXE=wscript.exe"
set "NONINTERACTIVE="

if /I not "%~1"=="" set "NONINTERACTIVE=1"

if /I "%~1"=="server" goto START_VISIBLE
if /I "%~1"=="silent" goto START_SILENT
if /I "%~1"=="stop" goto STOP_SERVER
if /I "%~1"=="status" goto SHOW_STATUS
if /I "%~1"=="config" goto CHANGE_BIND
if /I "%~1"=="reset" goto RESET_BIND
if /I "%~1"=="startup-on" goto AUTO_ON
if /I "%~1"=="startup-off" goto AUTO_OFF
if /I "%~1"=="startup-status" goto AUTO_STATUS
if /I "%~1"=="startup-test" goto TEST_STARTUP_NOW
if /I "%~1"=="panel" goto OPEN_STATUS_PANEL
if /I "%~1"=="test" goto RUN_TESTS

:MENU
cls
echo =========================================
echo LAN Quick Transfer Launcher
echo =========================================
echo 1. Start visible console
echo 2. Start silent background mode
echo 3. Stop background server
echo 4. Show server status
echo 5. Change bind IP and port
echo 6. Reset bind to 0.0.0.0:auto port ^(18082+^)
echo 7. Enable auto start ^(silent background^)
echo 8. Disable auto start
echo 9. Show auto start status
echo 10. Test auto start now
echo 11. Open status panel
echo 12. Run regression tests
echo 13. Exit
echo.
set /p choice="Select 1-13: "

if "%choice%"=="1" goto START_VISIBLE
if "%choice%"=="2" goto START_SILENT
if "%choice%"=="3" goto STOP_SERVER
if "%choice%"=="4" goto SHOW_STATUS
if "%choice%"=="5" goto CHANGE_BIND
if "%choice%"=="6" goto RESET_BIND
if "%choice%"=="7" goto AUTO_ON
if "%choice%"=="8" goto AUTO_OFF
if "%choice%"=="9" goto AUTO_STATUS
if "%choice%"=="10" goto TEST_STARTUP_NOW
if "%choice%"=="11" goto OPEN_STATUS_PANEL
if "%choice%"=="12" goto RUN_TESTS
if "%choice%"=="13" exit /b 0

echo Invalid choice.
echo.
pause
goto MENU

:START_VISIBLE
cls
echo Preparing visible console...
echo.
call :ENSURE_RUNTIME
if errorlevel 1 goto AFTER_ACTION
echo Starting visible server console...
echo Press Ctrl+C in the server window to stop it.
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "start_server.ps1" "%RUNTIME%"
goto AFTER_ACTION

:START_SILENT
cls
echo Preparing silent background mode...
echo.
call :ENSURE_RUNTIME
if errorlevel 1 goto AFTER_ACTION
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "scripts\start_server_hidden.ps1" "%RUNTIME%"
goto AFTER_ACTION

:STOP_SERVER
cls
echo Stopping server...
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "scripts\stop_server.ps1"
goto AFTER_ACTION

:SHOW_STATUS
cls
echo Checking server status...
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "scripts\show_server_status.ps1"
goto AFTER_ACTION

:CHANGE_BIND
cls
echo Changing bind IP and port...
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "scripts\change_bind_config.ps1"
goto AFTER_ACTION

:RESET_BIND
cls
echo Resetting bind IP and port...
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "scripts\change_bind_config.ps1" -ResetDefault
goto AFTER_ACTION

:AUTO_ON
cls
echo Enabling auto start...
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "scripts\configure_startup_autorun.ps1" enable
goto AFTER_ACTION

:AUTO_OFF
cls
echo Disabling auto start...
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "scripts\configure_startup_autorun.ps1" disable
goto AFTER_ACTION

:AUTO_STATUS
cls
echo Checking auto start status...
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "scripts\configure_startup_autorun.ps1" status
goto AFTER_ACTION

:TEST_STARTUP_NOW
cls
echo Testing auto start now...
echo.
if not exist "scripts\startup_silent_launcher.vbs" (
    echo startup_silent_launcher.vbs was not found.
    goto AFTER_ACTION
)
"%WSCRIPT_EXE%" "scripts\startup_silent_launcher.vbs"
if errorlevel 1 (
    echo Auto start test failed.
) else (
    echo Auto start test launched successfully.
)
goto AFTER_ACTION

:OPEN_STATUS_PANEL
cls
echo Opening status panel...
echo.
if not exist "scripts\server_status.hta" (
    echo server_status.hta was not found.
    goto AFTER_ACTION
)
start "" "%MSHTA_EXE%" "scripts\server_status.hta"
echo Status panel launched.
goto AFTER_ACTION

:RUN_TESTS
cls
echo Running regression tests...
echo.
call :ENSURE_RUNTIME
if errorlevel 1 goto AFTER_ACTION
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "scripts\run_regression_tests.ps1" -Runtime "%RUNTIME%" -Target all
goto AFTER_ACTION

:AFTER_ACTION
if defined NONINTERACTIVE exit /b %ERRORLEVEL%
echo.
pause
goto MENU

:ENSURE_RUNTIME
set "RUNTIME="
set "NPM_CMD="
set "NODE_MAJOR="
set "NODE_MAJOR_FILE=%TEMP%\lan_qt_node_major.txt"
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "RUNTIME=%ProgramFiles%\nodejs\node.exe"
    if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo Node.js was not found. Please install Node.js first.
        echo.
        pause
        exit /b 1
    )
    set "RUNTIME=node"
    set "NPM_CMD=npm"
)

if exist "%NODE_MAJOR_FILE%" del /f /q "%NODE_MAJOR_FILE%" >nul 2>nul
"%RUNTIME%" -p "process.versions.node.split('.')[0]" > "%NODE_MAJOR_FILE%" 2>nul
if exist "%NODE_MAJOR_FILE%" set /p NODE_MAJOR=<"%NODE_MAJOR_FILE%"
if exist "%NODE_MAJOR_FILE%" del /f /q "%NODE_MAJOR_FILE%" >nul 2>nul
if not defined NODE_MAJOR (
    echo Failed to detect the Node.js version.
    echo.
    pause
    exit /b 1
)

if %NODE_MAJOR% LSS 18 (
    echo Node.js 18 or later is required. Current major version: %NODE_MAJOR%
    echo Please upgrade Node.js, then run this launcher again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing dependencies...
    call "%NPM_CMD%" install
    if errorlevel 1 (
        echo Dependency installation failed.
        echo.
        pause
        exit /b 1
    )
)

exit /b 0
