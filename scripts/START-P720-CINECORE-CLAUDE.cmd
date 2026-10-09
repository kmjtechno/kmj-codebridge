@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "ROOT=D:\KMJ-HyperSpeed"
set "REPO=%ROOT%\projects\kmj-codebridge"
set "REPORT=%ROOT%\P720-CINECORE-AUTH-RESULT.txt"
if not exist "%ROOT%" mkdir "%ROOT%"
> "%REPORT%" echo KMJ P720 CINECORE ONE-CLICK - LOCAL DEVICE AUTHORIZATION
>>"%REPORT%" echo LAUNCH_DATE=%DATE% %TIME%
if not exist "%REPO%\.git" (
  >>"%REPORT%" echo BLOCKED: CodeBridge trusted D: checkout missing.
  goto :failed
)
where powershell.exe >nul 2>&1
if errorlevel 1 goto :failed
where git.exe >nul 2>&1
if errorlevel 1 goto :failed
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop';try {$r='D:\KMJ-HyperSpeed\projects\kmj-codebridge';$origin=(& git -C $r remote get-url origin);if ($LASTEXITCODE -ne 0 -or $origin -notmatch '^(https://github\.com/kmjtechno/kmj-codebridge(\.git)?|git@github\.com:kmjtechno/kmj-codebridge\.git)$'){throw 'Untrusted CodeBridge origin'};if ((& git -C $r branch --show-current).Trim() -ne 'main'){throw 'CodeBridge checkout not on main'};$dirty=@(& git -C $r status --porcelain);if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){throw 'CodeBridge checkout dirty: no files reset'};& git -C $r fetch origin main;if ($LASTEXITCODE -ne 0){throw 'CodeBridge fetch failed'};& git -C $r merge --ff-only origin/main;if ($LASTEXITCODE -ne 0){throw 'CodeBridge fast-forward merge blocked'};$head=(& git -C $r rev-parse HEAD).Trim();if ($head -notmatch '^[a-f0-9]{40}$'){throw 'Unverified CodeBridge HEAD'};$script=Join-Path $r 'scripts\setup-p720-cinecore.ps1';if (!(Test-Path -LiteralPath $script)){throw 'CineCore installer missing at HEAD'};& $script;if (!$?){exit 2};exit 0}catch{Write-Host ('BLOCKED: '+$_.Exception.Message);exit 2}"
set "RC=%ERRORLEVEL%"
echo.
if exist "%REPORT%" type "%REPORT%"
echo.
echo REPORT: %REPORT%
echo EXIT: %RC%
pause
exit /b %RC%
:failed
echo BLOCKED: Git, PowerShell and the authorized D: CodeBridge checkout are required.
>>"%REPORT%" echo BLOCKED: required local tools or trusted checkout missing.
pause
exit /b 2
