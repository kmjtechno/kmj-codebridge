@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Connect Existing CodeBridge Device
echo KMJ TECHNO ^| ONE-CLICK DEVICE CONNECTION
echo Already approved P720 CodeBridge only. No new tokens or source changes.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
where powershell.exe >nul 2>&1
if errorlevel 1 goto :blocked
set "SCRIPT=%~dp0CONNECT-P720-CODEBRIDGE.ps1"
if not exist "%SCRIPT%" goto :blocked
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%SCRIPT%"
set "RESULT=%ERRORLEVEL%"
echo.
echo Connect result: %RESULT%
echo Check the device in your authenticated KMJ CodeBridge client.
pause
exit /b %RESULT%
:blocked
echo DEVICE_CONNECT=BLOCKED:WINDOWS_POWERSHELL_OR_SCRIPT_MISSING
pause
exit /b 2
