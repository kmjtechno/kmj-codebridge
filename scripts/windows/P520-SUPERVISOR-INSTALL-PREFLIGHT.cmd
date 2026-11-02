@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ P520 CodeBridge - Read-Only Supervisor Install Preflight
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" (
  echo P520_PREFLIGHT=BLOCKED_WRONG_PC
  exit /b 2
)
set "KMJ_P520_PREFLIGHT_SCRIPT=%~dp0P520-SUPERVISOR-INSTALL-PREFLIGHT.ps1"
set "KMJ_P520_PREFLIGHT_SHA=8ef7c529aeb9ca69336a4df2e69da969667b464cb835e6086769aa9242371dcd"
echo KMJ P520 Supervisor - read-only discovery, no install or restart
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -Command "$ErrorActionPreference='Stop'; $script=$env:KMJ_P520_PREFLIGHT_SCRIPT; $expected=$env:KMJ_P520_PREFLIGHT_SHA; if(-not(Test-Path -LiteralPath $script -PathType Leaf)){throw 'SCRIPT_MISSING'}; $hash=(Get-FileHash -LiteralPath $script -Algorithm SHA256).Hash; if($hash -ine $expected){throw 'SCRIPT_HASH_MISMATCH'}; Write-Output 'P520_PREFLIGHT_SHA256=PASS'; & $env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $script -SelfTest; if($LASTEXITCODE -ne 0){throw 'SELFTEST_FAILED'}; & $env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $script; if($LASTEXITCODE -ne 0){throw 'PREFLIGHT_FAILED'}"
if errorlevel 1 (
  echo P520_PREFLIGHT=FAILED_NO_CHANGES
  pause
  exit /b 2
)
echo P520_PREFLIGHT=COMPLETE_NO_CHANGES
pause
exit /b 0
