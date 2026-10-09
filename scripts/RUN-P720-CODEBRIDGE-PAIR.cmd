@echo off
setlocal EnableExtensions
set "SCRIPT=%~dp0setup-p720-codebridge.ps1"
if not exist "%SCRIPT%" (
  echo BLOCKED: Missing CodeBridge P720 pairing script.
  pause
  exit /b 2
)
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo BLOCKED: Windows PowerShell required.
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "RESULT=%ERRORLEVEL%"
echo.
echo Report: D:\KMJ-HyperSpeed\P720-CODEBRIDGE-STATUS.txt
echo Exit code: %RESULT%
pause
exit /b %RESULT%
