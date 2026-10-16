@echo off
setlocal EnableExtensions
title KMJ TECHNO - P720 Agent Task Principal Diagnostics
echo KMJ TECHNO - Existing Agent Task Principal Breakdown
echo READ ONLY: account identity match, logon method, elevation policy.
echo Never prints account names, SIDs, tokens or process arguments.
echo Never changes any task, service, agent or CineCore.
echo Run as administrator for accurate Windows process ownership.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0DIAGNOSE-P720-AGENT-TASK-PRINCIPAL.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
 echo.
 echo KMJ_PRINCIPAL_DIAG_LAUNCHER=REVIEW_REQUIRED
 echo Do not rerun setup, modify the task principal or start the disabled task.
) else (
 echo.
 echo KMJ_PRINCIPAL_DIAG_LAUNCHER=READ_ONLY_PASS
 echo No task changes were applied.
)
pause
exit /b %RC%
