@echo off
setlocal EnableExtensions
title KMJ TECHNO - Recover Interrupted Supervisor Setup
echo KMJ TECHNO - P720 Native Supervisor Safe Recovery
echo Detects a still-running installer and REFUSES to start a second one.
echo Reuses only a verified isolated SHA release or existing disabled task.
echo Never resets development worktrees, replaces tokens or restarts CineCore.
echo Right-click this launcher and select Run as administrator.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0RECOVER-P720-SUPERVISOR.ps1" -Apply
if errorlevel 1 (
  echo.
  echo KMJ_RECOVERY=BLOCKED
  echo Preserve ALL files, tokens and backups. Do NOT re-run the old installer.
) else (
  echo.
  echo KMJ_RECOVERY=CHECK_OUTPUT_ABOVE
  echo Only KMJ_RECOVERY_SUPERVISOR=VERIFIED proves local HMAC status.
  echo Old CodeBridge agent handoff remains a separate step.
)
pause
endlocal
