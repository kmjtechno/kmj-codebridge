@echo off
setlocal EnableExtensions
title KMJ TECHNO - Safe P720 Read-only Project Rollout
echo KMJ TECHNO - P720 Read-only Project Supervisor Cutover
echo The existing agent, enrollment, dirty checkout and CineCore stay untouched.
echo Stages a SHA-pinned supervisor, backs up config and task action,
echo then requires HMAC + read-only project status. Rolls back on failure.
echo Run as administrator only after the source PR is fully verified.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0ROLLOUT-P720-READONLY-PROJECT.ps1" -Apply
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
 echo.
 echo KMJ_ROLLOUT=FAILED_OR_BLOCKED
 echo Preserve all backup, staged runtime and candidate files. No reinstall.
) else (
 echo.
 echo KMJ_ROLLOUT_LOCAL=PASS
 echo Verify remote supervisor_project_status from KMJ CodeBridge.
)
pause
exit /b %RC%
