@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Calibration Pro IDE Connection
echo KMJ TECHNO ^| CALIBRATION PRO IDE CONNECTION
echo Connects only the authorized Home Office agent to existing CodeBridge.
echo First pairing requires YOUR browser approval. No remote shell or admin elevation.
echo Does not touch calibration files, projectors, other agents or Windows time.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :blocked
where powershell.exe >nul 2>&1
if errorlevel 1 goto :blocked
set "CONNECT=%~dp0ONE-CLICK-AGENT-AUTOCONNECT.ps1"
set "DOCTOR=%~dp0CODEBRIDGE-DEVICE-DOCTOR.ps1"
if not exist "%CONNECT%" goto :blocked
if not exist "%DOCTOR%" goto :blocked

powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%CONNECT%" -Device HomeOffice
set "RC=%ERRORLEVEL%"
echo.
echo ---- Local read-only diagnostic markers ----
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "%DOCTOR%" -Device HomeOffice
echo.
echo CONNECTION_LAUNCH_EXIT=%RC%
echo Actual ChatGPT gateway registration must be verified separately.
echo Once READY, IDE tools run approved jobs and return compact receipts here.
echo Do not share agent.json, enrollment.json, credentials or raw logs.
pause
exit /b %RC%

:blocked
echo CODEBRIDGE_IDE=BLOCKED_WRONG_HOST_OR_UNTRUSTED_RUNTIME
pause
exit /b 2
