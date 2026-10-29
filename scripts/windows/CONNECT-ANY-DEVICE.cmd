@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Connect Any Windows Device
echo KMJ TECHNO ^| ONE CLICK DEVICE CONNECTION
echo Existing device: select private enrollment. New device: approve pairing in your browser.
echo No admin access, token export, or owner project modification.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
where powershell.exe >nul 2>&1
if errorlevel 1 goto :blocked
set "SCRIPT=%~dp0ONE-CLICK-ANY-DEVICE.ps1"
if not exist "%SCRIPT%" goto :blocked
rem Drag a project folder onto this file (or pass it as the first argument)
rem to skip the folder picker. Other arguments pass through unchanged.
if "%~1"=="" goto :plain
if exist "%~1\*" goto :project
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%SCRIPT%" %*
goto :done
:project
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%SCRIPT%" -ProjectRoot "%~f1"
goto :done
:plain
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%SCRIPT%"
:done
set "RC=%ERRORLEVEL%"
echo.
echo KMJ CodeBridge exit code: %RC%
echo Check READY in authenticated CodeBridge after local agent reconnect.
echo Never share tokens or private agent.json.
pause
exit /b %RC%
:blocked
echo KMJ_UNIVERSAL=BLOCKED:WINDOWS_SCRIPT_MISSING
pause
exit /b 2
