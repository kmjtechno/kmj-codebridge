@echo off
setlocal EnableExtensions
title KMJ TECHNO - Verify Native Supervisor Read-only Project
echo KMJ TECHNO - P720 Read-only Project Health Check
echo READ ONLY: HMAC status, project authorization and write refusal.
echo No task restart, no enrollment or config mutation.
echo.
set "RUNTIME=D:\KMJ-HyperSpeed\codebridge-releases\4828da1e3a82f8c2372f648836e985626d8681f6"
set "CONFIG=D:\KMJ-HyperSpeed\private\p720-codebridge\supervisor.json"
where node.exe >nul 2>&1
if errorlevel 1 (
 echo KMJ_PROJECT_READONLY_VERIFY=NODE_UNAVAILABLE
 pause
 exit /b 2
)
node.exe "%~dp0verify-p720-readonly-rollout.mjs" live "%RUNTIME%" "%CONFIG%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
 echo KMJ_PROJECT_READONLY_VERIFY=FAIL
) else (
 echo KMJ_PROJECT_READONLY_VERIFY=PASS
)
pause
exit /b %RC%
