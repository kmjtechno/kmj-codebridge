@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "ROOT=D:\KMJ-HyperSpeed"
set "REPO=%ROOT%\projects\kmj-codebridge"
set "REPORT=%ROOT%\P720-CINECORE-SAFE-REFRESH-RESULT.txt"
if not exist "%ROOT%" mkdir "%ROOT%"
> "%REPORT%" echo KMJ P720 CineCore guarded runtime refresh - local only
>> "%REPORT%" echo START=%DATE% %TIME%
where git.exe >nul 2>&1
if errorlevel 1 goto :failed
where powershell.exe >nul 2>&1
if errorlevel 1 goto :failed
if not exist "%REPO%\.git" goto :failed
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop';try {$r='D:\KMJ-HyperSpeed\projects\kmj-codebridge';$o=(& git.exe -C $r remote get-url origin).Trim();if ($LASTEXITCODE -ne 0 -or $o -cnotin @('https://github.com/kmjtechno/kmj-codebridge.git','https://github.com/kmjtechno/kmj-codebridge','git@github.com:kmjtechno/kmj-codebridge.git')){throw 'Untrusted CodeBridge origin'};if ((& git.exe -C $r branch --show-current).Trim() -ne 'main'){throw 'Not on clean CodeBridge main'};$dirty=@(& git.exe -C $r status --porcelain);if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){throw 'CodeBridge checkout dirty; no reset performed'};& git.exe -C $r fetch origin main;if ($LASTEXITCODE -ne 0){throw 'CodeBridge source fetch failed'};& git.exe -C $r merge --ff-only origin/main;if ($LASTEXITCODE -ne 0){throw 'CodeBridge fast-forward failed: no force reset'};$path=Join-Path $r 'scripts\p720-guarded-cinecore-refresh.ps1';if (!(Test-Path -LiteralPath $path)){throw 'Guarded runtime refresher missing'};& $path;exit $LASTEXITCODE}catch{Add-Content -LiteralPath 'D:\KMJ-HyperSpeed\P720-CINECORE-SAFE-REFRESH-RESULT.txt' -Value ('BLOCKED: '+$_.Exception.Message);Write-Host ('BLOCKED: '+$_.Exception.Message);exit 2}"
set "RC=%ERRORLEVEL%"
echo.
if exist "%REPORT%" type "%REPORT%"
echo.
echo RESULT: %REPORT%
echo EXIT: %RC%
pause
exit /b %RC%
:failed
>> "%REPORT%" echo BLOCKED: Git, PowerShell and trusted D: CodeBridge checkout are required.
echo Failed. See %REPORT%
pause
exit /b 2
