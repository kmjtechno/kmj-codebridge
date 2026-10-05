@echo off
setlocal
title KMJ CodeBridge - ChatGPT Desktop Setup

set "KMJ_SETUP_REF=9b27cfa3fb38c7cb08e1fda0da8cec384e625b06"
set "KMJ_SETUP_SHA256=ab82687d5ec6463925f415ae62bbdf0527073dac414de0ba0ad29c921c9a4bca"
set "KMJ_SETUP_URL=https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/%KMJ_SETUP_REF%/scripts/install-chatgpt-desktop.ps1"
set "KMJ_SETUP_FILE=%TEMP%\KMJ-CodeBridge-ChatGPT-Desktop.ps1"

echo.
echo KMJ CodeBridge - ChatGPT Desktop setup
echo Downloading the pinned public setup script...
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri '%KMJ_SETUP_URL%' -OutFile '%KMJ_SETUP_FILE%'"
if errorlevel 1 (
    echo.
    echo ERROR: Unable to download the KMJ CodeBridge setup script.
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$actual=(Get-FileHash -Algorithm SHA256 -LiteralPath '%KMJ_SETUP_FILE%').Hash.ToLowerInvariant(); if ($actual -ne '%KMJ_SETUP_SHA256%') { Write-Error ('KMJ setup integrity check failed. Expected %KMJ_SETUP_SHA256%, got ' + $actual); exit 10 }"
if errorlevel 1 (
    del /q "%KMJ_SETUP_FILE%" >nul 2>&1
    echo.
    echo ERROR: KMJ CodeBridge setup integrity verification failed.
    pause
    exit /b 10
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
