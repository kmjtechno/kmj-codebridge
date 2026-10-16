@echo off
setlocal EnableExtensions
title KMJ TECHNO - Prepare Disabled P720 Agent Task
echo KMJ TECHNO - P720 Native Agent Scheduled-Task Preparation
echo Creates a DISABLED task only. No agent restart, update or CineCore changes.
echo Current agent must remain online. This does NOT activate task-based restart.
echo Run as administrator only on the approved CodeBridge P720 workstation.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0PREPARE-P720-AGENT-TASK.ps1" -Apply
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo KMJ_AGENT_TASK_PREPARE=FAILED_OR_BLOCKED
  echo Preserve any registered task. Do not retry after partial registration.
) else (
  echo KMJ_AGENT_TASK_PREPARE=DISABLED_ONLY
  echo Next: isolated takeover with idle gating, heartbeat and rollback.
)
pause
exit /b %RC%
