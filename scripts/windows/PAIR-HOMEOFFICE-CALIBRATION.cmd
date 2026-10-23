@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Pair Home Office Calibration Pro
echo KMJ TECHNO ^| HOME OFFICE CALIBRATION PRO DEVICE PAIRING
echo This is NOT a Lenovo P720 device. Owner browser approval required.
echo Does not edit calibration files, PC time, or other agents.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
where powershell.exe >nul 2>&1
if errorlevel 1 goto :blocked
set "SCRIPT=%~dp0PAIR-HOMEOFFICE-CALIBRATION.ps1"
if not exist "%SCRIPT%" goto :blocked
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%SCRIPT%"
set "RESULT=%ERRORLEVEL%"
echo.
echo Home Office pairing exit: %RESULT%
echo Share only HOMEOFFICE_PAIR and CALIBRATION_RECONNECT status markers.
echo Never share agent.json, enrollment.json, bearer token, or logs.
pause
exit /b %RESULT%
:blocked
echo HOMEOFFICE_PAIR=BLOCKED:WINDOWS_POWERSHELL_OR_SCRIPT_MISSING
pause
exit /b 2
