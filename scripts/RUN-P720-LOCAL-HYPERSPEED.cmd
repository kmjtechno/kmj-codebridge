@echo off
setlocal EnableExtensions DisableDelayedExpansion
echo KMJ CodeBridge P720 - isolated local model cold/warm benchmark
echo No service restart, enrollment change, model download, or paid cloud inference.
if not exist "%~dp0p720-isolated-benchmark.ps1" (
  echo BLOCKED: audited PowerShell benchmark runner not found beside launcher.
  exit /b 2
)
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0p720-isolated-benchmark.ps1"
set "BENCH_EXIT=%ERRORLEVEL%"
echo.
echo BENCH_EXIT_CODE=%BENCH_EXIT%
pause
exit /b %BENCH_EXIT%
