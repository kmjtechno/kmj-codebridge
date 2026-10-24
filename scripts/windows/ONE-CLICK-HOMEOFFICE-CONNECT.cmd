@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - HOMEOFFICE Connect and Auto-Start
echo KMJ TECHNO ^| CODEBRIDGE ONE CLICK CONNECT + SIGN-IN STARTUP
echo Device identity fixed: HomeOffice. No unrelated devices, admin rights or token export.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
where powershell.exe >nul 2>&1
if errorlevel 1 goto :blocked
set "SCRIPT=%~dp0ONE-CLICK-AGENT-AUTOCONNECT.ps1"
if not exist "%SCRIPT%" goto :blocked
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%SCRIPT%" -Device HomeOffice
set "RESULT=%ERRORLEVEL%"
echo.
echo KMJ CodeBridge result: %RESULT%
echo Share only fixed STATUS= markers. Never share agent.json, enrollment or tokens.
pause
exit /b %RESULT%
:blocked
echo KMJ_AUTOCONNECT=BLOCKED:WINDOWS_OR_TRUSTED_SCRIPT_MISSING
pause
exit /b 2
