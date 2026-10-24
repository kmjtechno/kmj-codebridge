@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Calibration Pro Secure IDE Setup

echo KMJ TECHNO ^| SECURE HOME OFFICE CODEBRIDGE IDE SETUP
echo Verify the exact published bootstrap SHA256 before clearing only its downloaded-file marker.
echo No global Windows policy changes, execution-policy bypass, elevation or overwrites.
echo First pairing requires owner browser approval; gateway READY must be checked separately.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :blocked
set "KMJ_IDE_INSTALLER=%~dp0BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1"
set "KMJ_IDE_SOURCE_SHA256=d867a1f0131cce424b0fa90aaa91a847ecfa404088409e341e9b1df161ac60f5"
set "KMJ_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%KMJ_PS%" goto :blocked
if not exist "%KMJ_IDE_INSTALLER%" goto :blocked

rem One PowerShell process: verify exact bytes, remove only this file's Zone.Identifier,
rem then invoke the pinned file under RemoteSigned. On any mismatch: FAIL CLOSED.
"%KMJ_PS%" -NoProfile -STA -ExecutionPolicy RemoteSigned -Command "try { $ErrorActionPreference='Stop'; $f=$env:KMJ_IDE_INSTALLER; $want=$env:KMJ_IDE_SOURCE_SHA256; $actual=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant(); if($actual -cne $want) { Write-Output 'KMJ_IDE_SCRIPT_TRUST=BLOCKED_SHA256_MISMATCH'; exit 7 }; $motw=Get-Item -LiteralPath $f -Stream Zone.Identifier -ErrorAction SilentlyContinue; if($null -ne $motw) { Unblock-File -LiteralPath $f -ErrorAction Stop; $remaining=Get-Item -LiteralPath $f -Stream Zone.Identifier -ErrorAction SilentlyContinue; if($null -ne $remaining) { Write-Output 'KMJ_IDE_SCRIPT_TRUST=BLOCKED_MARKER_REMAINS'; exit 8 }; Write-Output 'KMJ_IDE_FILE_MARKER=REMOVED_VERIFIED_FILE_ONLY' }; $after=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant(); if($after -cne $want) { Write-Output 'KMJ_IDE_SCRIPT_TRUST=BLOCKED_CHANGED_FILE'; exit 7 }; Write-Output 'KMJ_IDE_SCRIPT_TRUST=PINNED_SHA256_PASS'; & $f; if($LASTEXITCODE -is [int]) { exit $LASTEXITCODE } else { exit 0 } } catch { Write-Output 'KMJ_IDE_SCRIPT_TRUST=BLOCKED_VERIFICATION_OR_POLICY'; exit 2 }"
set "RC=%ERRORLEVEL%"
echo.
echo IDE_INSTALLER_EXIT=%RC%
echo ChatGPT connection still requires authenticated gateway READY verification.
echo Do not share agent configs, private credentials or verbose logs.
pause
exit /b %RC%

:blocked
echo IDE_SETUP=BLOCKED_WRONG_HOST_OR_SCRIPT_MISSING
pause
exit /b 2
