@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - CodeBridge Home Office One Click
color 0F

echo =======================================================
echo   KMJ TECHNO ^| CODEBRIDGE HOME OFFICE ONE-CLICK
echo =======================================================
echo   Reconnect existing runtime first. Install only if missing.
echo   Owner browser approval is required for first pairing.
echo   No global policy bypass, admin elevation or project changes.
echo.
if /I not "%OS%"=="Windows_NT" goto :wrong_os
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :wrong_pc
set "KMJ_CB_HOST=DESKTOP-5FVJMET"
set "KMJ_CB_SHA=9dc0ae25648c33a62631fdd35068e6b60820637d"
set "KMJ_CB_SOURCE=https://github.com/kmjtechno/kmj-codebridge.git"
set "KMJ_CB_CMD=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%KMJ_CB_CMD%" goto :missing_powershell
"%KMJ_CB_CMD%" -NoProfile -STA -ExecutionPolicy RemoteSigned -Command "& { $ErrorActionPreference='Stop'; function Mark($a,$b){Write-Output ($a+'='+$b)}; function Fail($code){Mark 'CODEBRIDGE_ONECLICK' ('BLOCKED_'+$code); exit 2}; $git=(Get-Command git.exe -ErrorAction SilentlyContinue); $node=(Get-Command node.exe -ErrorAction SilentlyContinue); $npm=(Get-Command npm.cmd -ErrorAction SilentlyContinue); if(!$git){Fail 'GIT_MISSING'}; if(!$node -or !$npm){Fail 'NODE24_OR_NPM_MISSING'}; $ver=[string](& $node.Source --version); if($LASTEXITCODE -ne 0 -or $ver -notmatch '^v([0-9]+)\.' -or [int]$Matches[1] -lt 24){Fail 'NODE24_REQUIRED'}; $roots=@('E:\KMJ\CodeBridge-HomeOffice','E:\KMJ\CodeBridge','E:\KMJ\kmj-codebridge','D:\KMJ-HyperSpeed'); $allowed=@('https://github.com/kmjtechno/kmj-codebridge.git','https://github.com/kmjtechno/kmj-codebridge','git@github.com:kmjtechno/kmj-codebridge.git'); function Check($p){ if(!(Test-Path -LiteralPath $p -PathType Container)){return $false}; $it=Get-Item -LiteralPath $p; while($it){if($it.Attributes -band [IO.FileAttributes]::ReparsePoint){return $false};$it=$it.Parent}; if(!(Test-Path -LiteralPath (Join-Path $p 'src\cli.js') -PathType Leaf)){return $false}; $o=[string]((& $git.Source -C $p remote get-url origin 2>$null) | Select-Object -First 1); if($LASTEXITCODE -ne 0 -or $o.Trim() -cnotin $allowed){return $false}; $top=[string]((& $git.Source -C $p rev-parse --show-toplevel 2>$null) | Select-Object -First 1); if($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($top).TrimEnd([char]92) -ine [IO.Path]::GetFullPath($p).TrimEnd([char]92)){return $false}; $dirty=@(& $git.Source --no-optional-locks -C $p status --porcelain=v1 --untracked-files=no 2>$null); if($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){return $false}; $tracked=@(& $git.Source -C $p ls-files --error-unmatch -- 'scripts/windows/ONE-CLICK-AGENT-AUTOCONNECT.ps1' 2>$null); if($LASTEXITCODE -ne 0 -or $tracked.Count -lt 1){return $false}; return (Test-Path -LiteralPath (Join-Path $p 'node_modules\zod\package.json') -PathType Leaf) }; $runtime=$null; foreach($p in $roots){if(Check $p){$runtime=$p;break}}; if($null -ne $runtime){Mark 'CODEBRIDGE_RUNTIME' 'REUSED_EXISTING_TRACKED_CLEAN'}else{ $base=if(Test-Path -LiteralPath 'E:\KMJ' -PathType Container){'E:\KMJ'}else{Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\runtimes'}; $dest=Join-Path $base 'CodeBridge-HomeOffice'; if(Test-Path -LiteralPath $dest){Fail 'EXISTING_RUNTIME_REVIEW_REQUIRED'}; if(!(Test-Path -LiteralPath $base)){New-Item -ItemType Directory -Path $base -ErrorAction Stop | Out-Null}; $temp=Join-Path $base ('CodeBridge-stage-'+[guid]::NewGuid().ToString('N')); Mark 'CODEBRIDGE_INSTALL' 'PINNED_CLEAN_SOURCE'; & $git.Source clone --depth 1 --single-branch --branch main --no-checkout --no-tags $env:KMJ_CB_SOURCE $temp; if($LASTEXITCODE -ne 0){Fail 'CLONE_FAILED'}; & $git.Source -C $temp fetch --depth 1 --no-tags origin $env:KMJ_CB_SHA; if($LASTEXITCODE -ne 0){Fail 'PINNED_FETCH_FAILED'}; & $git.Source -C $temp checkout --detach $env:KMJ_CB_SHA; if($LASTEXITCODE -ne 0){Fail 'PINNED_CHECKOUT_FAILED'}; $head=[string]((& $git.Source -C $temp rev-parse HEAD) | Select-Object -First 1); if($head.Trim() -cne $env:KMJ_CB_SHA){Fail 'HEAD_MISMATCH'}; Push-Location -LiteralPath $temp; try{& $npm.Source ci --ignore-scripts --no-audit --no-fund; if($LASTEXITCODE -ne 0){Fail 'NPM_INSTALL_FAILED'}}finally{Pop-Location}; if(!(Check $temp)){Fail 'STAGED_RUNTIME_UNTRUSTED'}; if(Test-Path -LiteralPath $dest){Fail 'DESTINATION_EXISTS_NO_OVERWRITE'}; Move-Item -LiteralPath $temp -Destination $dest -ErrorAction Stop; if(!(Check $dest)){Fail 'PROMOTION_UNTRUSTED'}; $runtime=$dest; Mark 'CODEBRIDGE_RUNTIME' 'NEW_PINNED_INSTALL'}; $actualHead=[string]((& $git.Source -C $runtime rev-parse HEAD) | Select-Object -First 1); Mark 'CODEBRIDGE_RUNTIME_HEAD' $actualHead.Trim(); $script=Join-Path $runtime 'scripts\windows\ONE-CLICK-AGENT-AUTOCONNECT.ps1'; Mark 'CODEBRIDGE_NEXT' 'OWNER_PAIRING_OR_RECONNECT'; & $script -Device HomeOffice; if($LASTEXITCODE -ne 0){Fail 'CONNECT_OR_PAIRING_NOT_VERIFIED'}; Mark 'CODEBRIDGE_LOCAL' 'CONNECT_LAUNCHER_SUCCEEDED'; Mark 'CODEBRIDGE_GATEWAY_READY' 'NOT_ATTESTED_VERIFY_IN_CHAT' }"
set "RC=%ERRORLEVEL%"
echo.
echo CODEBRIDGE_ONECLICK_EXIT=%RC%
echo Account-side READY is checked in ChatGPT after this step.
echo Do not share enrollment tokens, agent.json or raw private logs.
pause
exit /b %RC%

:wrong_pc
echo CODEBRIDGE_ONECLICK=BLOCKED_PC_ID_MISMATCH
 echo EXPECTED_PC=DESKTOP-5FVJMET
 echo ACTUAL_PC=%COMPUTERNAME%
 echo No changes were made. This device needs its own owner-approved enrollment.
pause
exit /b 2
:wrong_os
echo CODEBRIDGE_ONECLICK=BLOCKED_WINDOWS_REQUIRED
pause
exit /b 2
:missing_powershell
echo CODEBRIDGE_ONECLICK=BLOCKED_WINDOWS_POWERSHELL_MISSING
pause
exit /b 2
