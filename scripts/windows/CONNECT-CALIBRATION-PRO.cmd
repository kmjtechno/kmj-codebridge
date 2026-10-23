@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Reconnect Existing Calibration Pro
echo KMJ TECHNO ^| CALIBRATION PRO DEVICE RECONNECT
echo Existing owner enrollment only. No reset, install, hardware scan or token export.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
where powershell.exe >nul 2>&1
if errorlevel 1 goto :blocked
set "SCRIPT=%~dp0CONNECT-CALIBRATION-PRO.ps1"
if not exist "%SCRIPT%" goto :blocked
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%SCRIPT%" -AutoDiscover
set "RESULT=%ERRORLEVEL%"
echo.
echo Result: %RESULT%
echo Verify the device grant using CodeBridge connection_overview.
pause
exit /b %RESULT%
:blocked
echo CALIBRATION_RECONNECT=BLOCKED:WINDOWS_OR_SCRIPT_MISSING
pause
exit /b 2
