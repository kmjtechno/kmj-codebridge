@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "RECOVERY=%~dp0p720-cinecore-reconnect.ps1"
if not exist "%RECOVERY%" (
  echo BLOCKED: Run from trusted KMJ CodeBridge scripts folder.
  pause
  exit /b 2
)
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%RECOVERY%"
set "RC=%ERRORLEVEL%"
echo.
echo Result: D:\KMJ-HyperSpeed\P720-CINECORE-RECONNECT-RESULT.txt
echo Exit: %RC%
pause
exit /b %RC%
