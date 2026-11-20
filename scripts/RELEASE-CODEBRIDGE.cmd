@echo off
setlocal EnableDelayedExpansion
rem KMJ CodeBridge - one double-click stable release (OWNER PC ONLY).
rem Signs with the offline key from %USERPROFILE%\.config\kmj-codebridge\release.env
rem (via scripts\release.sh) and opens the review PR. It never deploys anything.
cd /d "%~dp0.."
title KMJ CodeBridge release
set "OK=1"

set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not exist "%BASH%" (
  echo KMJ_RELEASE=BLOCKED:GIT_BASH_NOT_FOUND - install Git for Windows.
  set "OK=0"
)

if "%OK%"=="1" (
  where gh >nul 2>nul
  if errorlevel 1 (
    echo KMJ_RELEASE=BLOCKED:GH_NOT_FOUND - install GitHub CLI and run: gh auth login
    set "OK=0"
  )
)

if "%OK%"=="1" (
  for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%B"
  if /i not "!BRANCH!"=="main" (
    echo KMJ_RELEASE=BLOCKED:NOT_ON_MAIN - this checkout is on "!BRANCH!". Switch to main first.
    set "OK=0"
  )
)

if "%OK%"=="1" (
  git status --porcelain > "%TEMP%\kmj-release-dirty.txt"
  for %%F in ("%TEMP%\kmj-release-dirty.txt") do set "DIRTY=%%~zF"
  del "%TEMP%\kmj-release-dirty.txt" >nul 2>nul
  if not "!DIRTY!"=="0" (
    echo KMJ_RELEASE=BLOCKED:LOCAL_CHANGES - commit or stash your changes first.
    set "OK=0"
  )
)

if "%OK%"=="1" (
  echo Updating this checkout to the latest main, fast-forward only...
  git pull --ff-only origin main
  if errorlevel 1 (
    echo KMJ_RELEASE=BLOCKED:CANNOT_FAST_FORWARD
    set "OK=0"
  )
)

if "%OK%"=="1" (
  "%BASH%" scripts/release.sh %*
  echo.
  echo NEXT: open the pull request link above, check the green checks, compare
  echo MANIFEST_SHA256 with what was printed, then Approve and Merge it.
  echo Then tell Claude "done" - KMJ-elite applies the release automatically.
)

echo.
pause
endlocal
