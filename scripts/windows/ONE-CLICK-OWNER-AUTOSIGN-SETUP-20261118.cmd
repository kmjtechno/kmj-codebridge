@echo off
setlocal
rem KMJ owner host only. Requires one-time protected policy and reviewed source.
rem Does not launch Node signing directly; PowerShell controls exact task admission.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "%~dp0ONE-CLICK-OWNER-AUTOSIGN-SETUP-20261118.ps1" -Apply
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo OWNER_AUTOSIGN_ONE_CLICK=PASS
) else (
  echo OWNER_AUTOSIGN_ONE_CLICK=BLOCKED
)
echo No key was copied. No CodeBridge agent was restarted.
exit /b %RC%
