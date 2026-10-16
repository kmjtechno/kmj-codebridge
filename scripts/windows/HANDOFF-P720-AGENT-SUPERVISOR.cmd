@echo off
setlocal EnableExtensions
title KMJ TECHNO - Guarded P720 Agent Handoff
echo KMJ TECHNO - Native Supervisor / Agent Handoff
echo Requires already running HMAC-verified native supervisor.
echo Checks backup integrity, approved config difference and zero running jobs.
echo Applies only the CodeBridge agent config and restarts that scoped agent.
echo Never resets your dirty checkout, reinstalls supervisor or touches CineCore.
echo On failure, attempts original config and agent runtime rollback.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0HANDOFF-P720-AGENT-SUPERVISOR.ps1" -Apply
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo KMJ_HANDOFF=FAILED_OR_BLOCKED
  echo Do not delete backups or run an old one-click installer.
) else (
  echo.
  echo KMJ_HANDOFF_LOCAL=PASS
  echo Verify live supervisor_status from ChatGPT / KMJ CodeBridge.
)
pause
exit /b %RC%
