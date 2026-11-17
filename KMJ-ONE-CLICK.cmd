@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Universal One Click Device Connect
echo KMJ TECHNO ^| UNIVERSAL ONE CLICK
echo Existing approved device: safe reconnect.
echo New device: owner-browser pairing and scoped agent startup.
echo Uses an isolated verified runtime: does not clean or reset your project.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
where powershell.exe >nul 2>&1
if errorlevel 1 goto :blocked
set "STAGER=%~dp0scripts\windows\ONE-CLICK-ISOLATED-DEVICE.ps1"
if not exist "%STAGER%" goto :blocked
if not "%~2"=="" goto :blocked_args
if "%~1"=="" (
  powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%STAGER%"
) else (
  if not exist "%~f1\*" goto :blocked_args
  powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%STAGER%" -ProjectRoot "%~f1"
)
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" (
  echo KMJ_DEVICE_ONE_CLICK=LOCAL_FLOW_COMPLETED
  echo KMJ_ACCOUNT_READY=CHECK_AUTHENTICATED_CONNECTION_OVERVIEW
) else (
  echo KMJ_DEVICE_ONE_CLICK=BLOCKED
)
echo.
pause
exit /b %RC%
:blocked
echo KMJ_DEVICE_ONE_CLICK=BLOCKED_WINDOWS_ENTRY_MISSING
pause
exit /b 2
:blocked_args
echo KMJ_DEVICE_ONE_CLICK=BLOCKED_UNSUPPORTED_ARGUMENT
pause
exit /b 2
