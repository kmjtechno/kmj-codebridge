@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - Universal One Click Device Connect
echo KMJ TECHNO ^| UNIVERSAL ONE CLICK
echo Existing approved device: safe reconnect.
echo New device: owner-browser pairing and scoped agent startup.
echo Never share the agent credential or use another device's enrollment.
echo.
if /I not "%OS%"=="Windows_NT" goto :blocked
set "CONNECT=%~dp0scripts\windows\CONNECT-ANY-DEVICE.cmd"
if not exist "%CONNECT%" goto :blocked
if not "%~2"=="" goto :blocked_args
if "%~1"=="" (
  call "%CONNECT%"
) else (
  if not exist "%~f1\\*" goto :blocked_args
  call "%CONNECT%" "%~f1"
)
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" (
  echo KMJ_DEVICE_ONE_CLICK=LOCAL_FLOW_COMPLETED
  echo KMJ_ACCOUNT_READY=CHECK_AUTHENTICATED_CONNECTION_OVERVIEW
) else (
  echo KMJ_DEVICE_ONE_CLICK=BLOCKED
)
exit /b %RC%
:blocked
echo KMJ_DEVICE_ONE_CLICK=BLOCKED_WINDOWS_ENTRY_MISSING
pause
exit /b 2

:blocked_args
echo KMJ_DEVICE_ONE_CLICK=BLOCKED_UNSUPPORTED_ARGUMENT
pause
exit /b 2
