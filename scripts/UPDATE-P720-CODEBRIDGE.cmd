@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Run only on enrolled P720. Uses first-party Git+Node, not ChatGPT plugins.
set "SHA=8213dc872294865a2056f8fa4170db4a41f3b61b"
if not exist "%~dp0p720-native-agent-update.ps1" (
  echo BLOCKED: Audited updater is missing beside this launcher.
  exit /b 2
)
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo BLOCKED: Windows PowerShell unavailable.
  exit /b 2
)
echo KMJ CodeBridge native agent update - exact SHA %SHA%
echo Requires the single existing P720 CodeBridge agent to be idle.
echo Stages candidate first; tests it before scoped switch and rollback.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0p720-native-agent-update.ps1" -TargetSha %SHA%
set "RESULT=%ERRORLEVEL%"
echo CODEBRIDGE_UPDATE_EXIT=%RESULT%
pause
exit /b %RESULT%
