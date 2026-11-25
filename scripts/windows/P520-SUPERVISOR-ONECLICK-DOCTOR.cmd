@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0P520-SUPERVISOR-ONECLICK-DOCTOR.ps1"
set "rc=%ERRORLEVEL%"
pause
exit /b %rc%
