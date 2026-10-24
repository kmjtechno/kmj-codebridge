@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - P720 CodeBridge Doctor
echo KMJ TECHNO ^| CODEBRIDGE CONNECTION DIAGNOSTIC
echo Read-only. No credentials displayed or changed.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
where powershell.exe >nul 2>&1
if errorlevel 1 goto :blocked
set "DOCTOR=%~dp0CODEBRIDGE-DEVICE-DOCTOR.ps1"
if not exist "%DOCTOR%" goto :blocked
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "%DOCTOR%" -Device P720
set "RC=%ERRORLEVEL%"
echo.
echo Only share the status markers above. Never share agent.json or tokens.
pause
exit /b %RC%
:blocked
echo KMJ_PC_DOCTOR=BLOCKED_WINDOWS_OR_SCRIPT_MISSING
pause
exit /b 2
