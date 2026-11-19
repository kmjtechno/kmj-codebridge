@echo off
setlocal
rem Owner-only P520 activation: reviewed upgrade first, then guarded enable.
rem The task remains Disabled unless both fail-closed gates succeed.
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0OWNER-AUTOSIGN-SIGNER-PINNED-UPGRADE-20261119.ps1" -Apply
if errorlevel 1 (
  echo OWNER_AUTOSIGN_ACTIVATE=BLOCKED_UPGRADE
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0OWNER-AUTOSIGN-RESUME-GUARDED-20261119.ps1" -Apply
if errorlevel 1 (
  echo OWNER_AUTOSIGN_ACTIVATE=BLOCKED_RESUME
  exit /b 2
)
echo OWNER_AUTOSIGN_ACTIVATE=PASS_WAITING_FIRST_RUN
exit /b 0
