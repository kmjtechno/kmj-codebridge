@echo off
setlocal EnableExtensions
title KMJ TECHNO - Native Windows Supervisor
echo KMJ TECHNO - Native Windows Supervisor (no third-party runtime)
echo This is a ONE-TIME privileged preparation + authenticated activation.
echo It does NOT replace the connected agent or CineCore project.
echo If setup fails, do not delete backups or rerun against partial state.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0ONE-CLICK-P720-SUPERVISOR.ps1" -Apply
if errorlevel 1 (
  echo.
  echo KMJ_NATIVE_SUPERVISOR=FAILED_OR_BLOCKED
  echo Inspect the preserved manifest before retrying.
) else (
  echo.
  echo KMJ_NATIVE_SUPERVISOR=VERIFIED
  echo Agent handoff remains a separate validated step.
)
pause
endlocal
