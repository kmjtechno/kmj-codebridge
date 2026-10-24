@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Calibration Pro Secure IDE Setup

echo KMJ TECHNO ^| SECURE HOME OFFICE CODEBRIDGE IDE SETUP
echo Exact-commit clean runtime installation if missing; no overwrite.
echo Owner browser approval required for first device pairing.
echo Camera, projectors, production and calibration source are not changed.
echo.
if /I not "%OS%"=="Windows_NT" goto :unsupported_os
echo IDE_CURRENT_WINDOWS_HOST=%COMPUTERNAME%
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :wrong_host
set "INSTALLER=%~dp0BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1"
if not exist "%INSTALLER%" goto :missing_script
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" goto :missing_powershell
rem Downloaded ZIP extraction may mark the unsigned .ps1 as Internet-zone.
rem Trust ONLY the reviewed immutable SHA-256; never weaken machine-wide policy.
set "KMJ_IDE_BOOTSTRAP_FILE=%INSTALLER%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $p=$env:KMJ_IDE_BOOTSTRAP_FILE; $item=Get-Item -LiteralPath $p -ErrorAction Stop; if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'SCRIPT_REPARSE_DENIED'}; if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -cne 'D867A1F0131CCE424B0FA90AAA91A847ECFA404088409E341E9B1DF161AC60F5'){throw 'SCRIPT_SHA256_MISMATCH'}; if((Get-ExecutionPolicy) -eq 'AllSigned'){throw 'SCRIPT_ALLSIGNED_REQUIRES_SIGNATURE'}; Unblock-File -LiteralPath $p -ErrorAction Stop; if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -cne 'D867A1F0131CCE424B0FA90AAA91A847ECFA404088409E341E9B1DF161AC60F5'){throw 'SCRIPT_CHANGED_DURING_UNBLOCK'}; Write-Output 'IDE_LOCAL_HASH_VERIFICATION=PASS'; Write-Output 'EXECUTION_POLICY_CHANGED=NO'"
if errorlevel 1 goto :integrity_blocked
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%INSTALLER%"
set "RC=%ERRORLEVEL%"
echo.
echo IDE_INSTALLER_EXIT=%RC%
echo Actual ChatGPT connection still requires account-side READY verification.
echo Never share private agent configs, credentials or verbose logs.
pause
exit /b %RC%
:integrity_blocked
echo IDE_SETUP=BLOCKED_INSTALLER_INTEGRITY_OR_EXECUTION_POLICY
echo Verify this setup archive came from the approved KMJ TECHNO release.
echo A system-enforced AllSigned policy requires an authorized signed installer.
pause
exit /b 3
:unsupported_os
echo IDE_SETUP=BLOCKED_NOT_WINDOWS
pause
exit /b 2
:wrong_host
echo IDE_SETUP=BLOCKED_WRONG_HOST
echo IDE_EXPECTED_WINDOWS_HOST=DESKTOP-5FVJMET
pause
exit /b 2
:missing_script
echo IDE_SETUP=BLOCKED_BOOTSTRAP_SCRIPT_MISSING
echo ACTION=Extract BOTH START-KMJ-CALIBRATION-IDE.cmd and BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1 into SAME folder.
pause
exit /b 2
:missing_powershell
echo IDE_SETUP=BLOCKED_WINDOWS_POWERSHELL_MISSING
pause
exit /b 2
