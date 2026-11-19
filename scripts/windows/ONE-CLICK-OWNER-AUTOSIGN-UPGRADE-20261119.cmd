@echo off
setlocal
rem KMJ owner-host only: run the reviewed, hash-pinned signer upgrade.
rem The PowerShell script independently checks old and new blobs, task identity,
rem consent, ACLs and leaves a protected rollback copy. No key is copied.
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0OWNER-AUTOSIGN-SIGNER-PINNED-UPGRADE-20261119.ps1" -Apply
set "rc=%ERRORLEVEL%"
if "%rc%"=="0" (
  echo OWNER_AUTOSIGN_UPGRADE_ONE_CLICK=PASS
) else (
  echo OWNER_AUTOSIGN_UPGRADE_ONE_CLICK=BLOCKED
)
exit /b %rc%
