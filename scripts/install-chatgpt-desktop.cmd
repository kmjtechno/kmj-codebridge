@echo off
setlocal
title KMJ CodeBridge - ChatGPT Desktop Setup

set "KMJ_SETUP_URL=https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/main/scripts/install-chatgpt-desktop.ps1"
set "KMJ_SETUP_FILE=%TEMP%\KMJ-CodeBridge-ChatGPT-Desktop.ps1"

echo.
echo KMJ CodeBridge - ChatGPT Desktop setup
echo Downloading the verified public setup script...
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri '%KMJ_SETUP_URL%' -OutFile '%KMJ_SETUP_FILE%'"
if errorlevel 1 (
    echo.
    echo ERROR: Unable to download the KMJ CodeBridge setup script.
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%KMJ_SETUP_FILE%"
set "KMJ_SETUP_EXIT=%ERRORLEVEL%"

del /q "%KMJ_SETUP_FILE%" >nul 2>&1

if not "%KMJ_SETUP_EXIT%"=="0" (
    echo.
    echo ERROR: KMJ CodeBridge setup failed with exit code %KMJ_SETUP_EXIT%.
    pause
    exit /b %KMJ_SETUP_EXIT%
)

echo.
echo KMJ CodeBridge setup completed successfully.
echo Fully quit and reopen ChatGPT Desktop once.
pause
exit /b 0
