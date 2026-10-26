@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Home Office Calibration Pro Reconnect
echo KMJ TECHNO ^| SECURE HOME OFFICE EXISTING AGENT RECONNECT
echo Node 24+ only. Existing enrolled device reconnect only.
echo No credential export, downloads, service changes or project edits.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :blocked
set "NODE_SCRIPT=%~dp0connect-homeoffice-calibration.mjs"
if not exist "%NODE_SCRIPT%" goto :blocked
rem Use the existing owner-installed portable Node without changing global PATH.
rem Only explicit local toolchain / standard Node locations and the existing PATH.
rem Each candidate must actually report Node 24+ before agent code is launched.
set "NODE_EXE="
for %%F in ("%LOCALAPPDATA%\KMJ-CaliPro\toolchains\node.exe" "%ProgramFiles%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe") do call :consider_node "%%~fF"
if not defined NODE_EXE for /d %%D in ("%LOCALAPPDATA%\KMJ-CaliPro\toolchains\node*") do call :consider_node "%%~fD\node.exe"
if not defined NODE_EXE for /d %%D in ("%LOCALAPPDATA%\KMJ-CaliPro\toolchains\node*") do call :consider_node "%%~fD\bin\node.exe"
if not defined NODE_EXE for /f "delims=" %%F in ('where node.exe 2^>nul') do call :consider_node "%%~fF"
if not defined NODE_EXE goto :node_missing
"%NODE_EXE%" "%NODE_SCRIPT%"
set "RESULT=%ERRORLEVEL%"
echo.
echo CALIBRATION_NODE_RECONNECT_EXIT=%RESULT%
echo Verify READY in authenticated CodeBridge connection_overview.
echo Do not share agent.json, enrollment.json or raw logs.
pause
exit /b %RESULT%
:node_missing
echo CALIBRATION_RECONNECT=BLOCKED_NODE24_NOT_DISCOVERED
pause
exit /b 2
:blocked
echo CALIBRATION_RECONNECT=BLOCKED_WRONG_PC_OR_TRUSTED_RUNTIME
pause
exit /b 2

:consider_node
if defined NODE_EXE exit /b 0
if not exist "%~1" exit /b 0
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>nul
if errorlevel 1 exit /b 0
set "NODE_EXE=%~1"
exit /b 0
