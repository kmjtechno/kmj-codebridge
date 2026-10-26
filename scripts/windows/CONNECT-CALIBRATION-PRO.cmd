@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Home Office Calibration Pro Reconnect
echo KMJ TECHNO ^| SECURE HOME OFFICE EXISTING AGENT RECONNECT
echo Node 24+ only. No PowerShell policy change or new pairing.
echo No token export, downloads, services, installer or project edits.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :blocked
where node.exe >nul 2>&1
if errorlevel 1 goto :node_missing
set "NODE_SCRIPT=%~dp0connect-homeoffice-calibration.mjs"
if not exist "%NODE_SCRIPT%" goto :blocked
node.exe "%NODE_SCRIPT%"
set "RESULT=%ERRORLEVEL%"
echo.
echo CALIBRATION_NODE_RECONNECT_EXIT=%RESULT%
echo Verify READY in authenticated CodeBridge connection_overview.
echo Do not share agent.json, enrollment.json or raw logs.
pause
exit /b %RESULT%
:node_missing
echo CALIBRATION_RECONNECT=BLOCKED_NODE24_NOT_INSTALLED
pause
exit /b 2
:blocked
echo CALIBRATION_RECONNECT=BLOCKED_WRONG_PC_OR_TRUSTED_RUNTIME
pause
exit /b 2
