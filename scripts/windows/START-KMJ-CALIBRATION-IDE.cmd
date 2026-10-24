@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Calibration Pro Secure IDE Setup

echo KMJ TECHNO ^| SECURE HOME OFFICE CODEBRIDGE IDE SETUP
echo Exact-commit clean runtime installation if missing; no overwrite.
echo Owner browser approval required for first device pairing.
echo Camera, projectors, production and calibration source are not changed.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :blocked
set "INSTALLER=%~dp0BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1"
if not exist "%INSTALLER%" goto :blocked
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" goto :blocked
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%INSTALLER%"
set "RC=%ERRORLEVEL%"
echo.
echo IDE_INSTALLER_EXIT=%RC%
echo Actual ChatGPT connection still requires account-side READY verification.
echo Never share private agent configs, credentials or verbose logs.
pause
exit /b %RC%
:blocked
echo IDE_SETUP=BLOCKED_WRONG_HOST_OR_SCRIPT_MISSING
pause
exit /b 2
