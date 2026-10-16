@echo off
setlocal
title KMJ CodeBridge - P720 Supervisor Safe Preparation
echo KMJ TECHNO - One-time P720 Windows Supervisor Setup
echo This prepares a DISABLED supervisor only. It will NOT restart agents.
echo Right-click this file and choose "Run as administrator".
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0bootstrap-p720-supervisor.ps1" -Apply
if errorlevel 1 (
  echo.
  echo PREPARATION=FAILED
  echo Existing agents and development checkouts were not deliberately changed.
  echo Preserve any created backup or partial staged directory for review.
) else (
  echo.
  echo PREPARATION=FINISHED
  echo The task remains disabled until a separate verified activation.
)
pause
endlocal
