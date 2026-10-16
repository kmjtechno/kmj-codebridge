@echo off
setlocal EnableExtensions
title KMJ TECHNO - P720 Existing Agent Task Audit
echo KMJ TECHNO - Existing P720 Agent Scheduled Task Audit
echo READ ONLY: task state, identity, principal, pinned runtime and agent count.
echo Does NOT show tokens, account names or process command lines.
echo Does NOT start, enable, disable, register, overwrite or delete tasks.
echo Run as administrator for accurate process ownership visibility.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0AUDIT-P720-EXISTING-AGENT-TASK.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
 echo.
 echo KMJ_AGENT_TASK_AUDIT_LAUNCHER=REVIEW_REQUIRED
 echo Preserve the existing task and all agent processes.
) else (
 echo.
 echo KMJ_AGENT_TASK_AUDIT_LAUNCHER=COMPLETE_READ_ONLY
 echo Do not enable task until a guarded takeover is separately verified.
)
pause
exit /b %RC%
