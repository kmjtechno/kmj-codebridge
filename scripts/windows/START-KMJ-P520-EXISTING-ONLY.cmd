@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Home Office P520 Existing-Only Recovery
echo KMJ TECHNO ^| HOME OFFICE P520 ^| EXISTING PAIRING RECOVERY
echo Reconnects only an already approved scoped enrollment for kmj-calibration-pro.
echo NO new pairing, no credential copying, no global policy changes.
echo No calibration source, projectors, camera or other agents modified.
echo.
if /I not "%OS%"=="Windows_NT" goto :wrong_host
echo KMJ_P520_CURRENT_HOST=%COMPUTERNAME%
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :wrong_host
set "RECOVERY_SCRIPT=%~dp0RECOVER-P520-EXISTING-ONLY.ps1"
if not exist "%RECOVERY_SCRIPT%" goto :script_missing
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" goto :ps_missing
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop';$f=$env:RECOVERY_SCRIPT;$i=Get-Item -LiteralPath $f;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SCRIPT_REPARSE_DENIED'};$h='6610643B27ECBB903ECAA91BF1DDDBF591DE344226FA8E3ECC5CA93E9C3C9276';if((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash -cne $h){throw 'SCRIPT_SHA256_MISMATCH'};if((Get-ExecutionPolicy) -eq 'AllSigned'){throw 'SIGNED_SCRIPT_REQUIRED'};Unblock-File -LiteralPath $f -ErrorAction Stop;if((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash -cne $h){throw 'SCRIPT_CHANGED'};Write-Output 'KMJ_RECOVERY_OFFLINE_SHA256=PASS';Write-Output 'KMJ_WINDOWS_EXECUTION_POLICY_MODIFIED=NO'"
if errorlevel 1 goto :integrity_fail
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%RECOVERY_SCRIPT%"
set "RC=%ERRORLEVEL%"
echo KMJ_P520_RECOVERY_EXIT=%RC%
echo Device online state requires independent account/gateway confirmation.
echo Never share agent.json, enrollment.json, private state files or passwords.
pause
exit /b %RC%
:wrong_host
echo KMJ_P520_RECOVERY=BLOCKED:WRONG_WINDOWS_HOST
pause
exit /b 2
:script_missing
echo KMJ_P520_RECOVERY=BLOCKED:COMPANION_SCRIPT_MISSING
pause
exit /b 2
:ps_missing
echo KMJ_P520_RECOVERY=BLOCKED:WINDOWS_POWERSHELL_UNAVAILABLE
pause
exit /b 2
:integrity_fail
echo KMJ_P520_RECOVERY=BLOCKED:SCRIPT_INTEGRITY_OR_SYSTEM_POLICY
pause
exit /b 3
