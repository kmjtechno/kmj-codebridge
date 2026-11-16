@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ P520 CodeBridge - Read-Only Supervisor Install Preflight
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" (
  echo P520_PREFLIGHT=BLOCKED_WRONG_PC
  exit /b 2
)
set "KMJ_P520_PREFLIGHT_SCRIPT=%~dp0P520-SUPERVISOR-INSTALL-PREFLIGHT.ps1"
set "KMJ_P520_PREFLIGHT_SHA=61516fd34667934cd1112e851bc00d918e86824cef680f63e6d3eb7d04f3f243"
echo KMJ P520 Supervisor - read-only discovery, no install or restart
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -Command "$ErrorActionPreference='Stop'; $script=$env:KMJ_P520_PREFLIGHT_SCRIPT; $expected=$env:KMJ_P520_PREFLIGHT_SHA; if(-not(Test-Path -LiteralPath $script -PathType Leaf)){throw 'SCRIPT_MISSING'}; $hash=(Get-FileHash -LiteralPath $script -Algorithm SHA256).Hash; if($hash -ine $expected){throw 'SCRIPT_HASH_MISMATCH'}; Write-Output 'P520_PREFLIGHT_SHA256=PASS'; & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $script -SelfTest; if($LASTEXITCODE -ne 0){throw 'SELFTEST_FAILED'}; & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $script; if($LASTEXITCODE -ne 0){throw 'PREFLIGHT_FAILED'}"
if errorlevel 1 (
  echo P520_PREFLIGHT=FAILED_NO_CHANGES
  pause
  exit /b 2
)
echo P520_PREFLIGHT=COMPLETE_NO_CHANGES
pause
exit /b 0
