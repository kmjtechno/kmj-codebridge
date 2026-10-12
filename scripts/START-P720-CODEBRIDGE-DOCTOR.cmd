@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "DOCTOR=%~dp0P720-CODEBRIDGE-DOCTOR.ps1"
if not exist "%DOCTOR%" (
 echo BLOCKED: Place this launcher with the trusted P720 CodeBridge doctor script.
 pause
 exit /b 2
)
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%DOCTOR%"
set "RC=%ERRORLEVEL%"
echo.
echo CodeBridge doctor exit code: %RC%
echo No enrollments, credentials, services or source files were changed.
pause
exit /b %RC%
