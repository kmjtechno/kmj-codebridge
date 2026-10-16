@echo off
setlocal
title KMJ CodeBridge - Secure Windows Supervisor Activation
echo KMJ TECHNO - Verified P720 Supervisor Activation
echo This starts only the exact prepared KMJ-CodeBridge-Supervisor task.
echo Existing agent configuration and CineCore are not changed.
echo Right-click this file and choose "Run as administrator".
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0activate-p720-supervisor.ps1" -Apply
if errorlevel 1 (
  echo ACTIVATION=FAIL
  echo The script attempts to disable the supervisor on activation failure.
  echo Preserve the installer backup for review.
) else (
  echo ACTIVATION=PASS
  echo Agent wiring still requires a separate, verified integration step.
)
pause
endlocal
