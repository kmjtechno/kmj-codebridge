@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - P520 One-Click Native Supervisor
echo KMJ TECHNO - P520 Native Supervisor One-Click
echo.
echo Exact prepared task only. Existing agent and OmniDesk stay untouched.
echo Validates backup SHA, token ACL, pinned release and one live agent.
echo Starts only the prepared Supervisor; requires live authenticated HMAC.
echo If activation fails, disables the task and reports rollback result.
echo.
fltmc >nul 2>&1
if errorlevel 1 (
  echo P520_ONE_CLICK=BLOCKED_ADMIN_REQUIRED
  echo Use right-click ^> Run as administrator on this launcher.
  pause
  exit /b 2
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0ONE-CLICK-P520-ACTIVATE-20261117.ps1" -Apply
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo P520_ONE_CLICK_LOCAL=BLOCKED
  echo Keep the current agent running. Do not rerun preparation or delete backups.
) else (
  echo.
  echo P520_ONE_CLICK_LOCAL=PASS
  echo Native Supervisor is running. Agent wiring remains separately gated.
  echo Verify live connection from KMJ CodeBridge before declaring rollout complete.
)
pause
exit /b %RC%
