@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "REPO=D:\KMJ-HyperSpeed\projects\kmj-codebridge"
echo KMJ P720 - FREE ONE-CLICK CODEBRIDGE PAIRING
echo Scope: D: CodeBridge project only. No paid providers or production changes.
echo.
if not exist "%REPO%\.git" (
  echo BLOCKED: D: CodeBridge checkout not found.
  goto :failed
)
where powershell.exe >nul 2>&1
if errorlevel 1 goto :failed
where git.exe >nul 2>&1
if errorlevel 1 goto :failed
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $r='D:\KMJ-HyperSpeed\projects\kmj-codebridge'; $origin=(& git -C $r remote get-url origin); if ($LASTEXITCODE -ne 0 -or $origin -notmatch '^(https://github\.com/kmjtechno/kmj-codebridge(\.git)?|git@github\.com:kmjtechno/kmj-codebridge\.git)$') { throw 'Untrusted Git remote' }; if ((& git -C $r branch --show-current).Trim() -ne 'main') { throw 'Not on main branch' }; $dirty=@(& git -C $r status --porcelain); if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) { throw 'Dirty checkout: no reset attempted' }; & git -C $r fetch origin main; if ($LASTEXITCODE -ne 0) { throw 'Git fetch failed' }; & git -C $r merge --ff-only origin/main; if ($LASTEXITCODE -ne 0) { throw 'Fast-forward only merge failed' }; $f=Join-Path $r 'scripts\setup-p720-codebridge.ps1'; if (!(Test-Path -LiteralPath $f)) { throw 'Paired installer missing after sync' }; & $f; if (!$?) { exit 2 } } catch { Write-Host ('BLOCKED: ' + $_.Exception.Message); exit 2 }"
set "RESULT=%ERRORLEVEL%"
echo.
echo Results: D:\KMJ-HyperSpeed\P720-CODEBRIDGE-STATUS.txt
echo Pairing will ask for approval in your KMJ browser account.
pause
exit /b %RESULT%
:failed
echo BLOCKED: Git and Windows PowerShell must be installed and D: workspace available.
pause
exit /b 2
