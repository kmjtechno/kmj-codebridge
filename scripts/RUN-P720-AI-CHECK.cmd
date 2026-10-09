@echo off
setlocal EnableExtensions
set "REPORT=D:\KMJ-HyperSpeed\P720-AI-READINESS.json"
if not exist "D:\KMJ-HyperSpeed" mkdir "D:\KMJ-HyperSpeed"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 is required for this readiness check.
  exit /b 2
)
node "%~dp0p720-ai-check.mjs" > "%REPORT%"
set "CHECK_EXIT=%ERRORLEVEL%"
type "%REPORT%"
echo.
echo Saved: %REPORT%
echo Check exit code: %CHECK_EXIT%
exit /b %CHECK_EXIT%
