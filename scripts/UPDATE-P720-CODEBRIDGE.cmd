@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Run only on enrolled P720. Uses first-party Git+Node, not ChatGPT plugins.
set "SHA=ff0afff981c3e0621b6c6d1e355e66a511c8720b"
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
echo Tracked-only unstaged edits are fingerprinted and preserved; no checkout reset.
echo Stages candidate first; tests it before scoped switch and rollback.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0p720-native-agent-update.ps1" -TargetSha %SHA% -AllowTrackedDirtyCheckout
set "RESULT=%ERRORLEVEL%"
echo CODEBRIDGE_UPDATE_EXIT=%RESULT%
pause
exit /b %RESULT%
