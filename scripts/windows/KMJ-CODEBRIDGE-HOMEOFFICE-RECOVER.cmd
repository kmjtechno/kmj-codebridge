@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ TECHNO - CodeBridge Home Office One Click
color 0F

echo =======================================================
echo   KMJ TECHNO ^| CODEBRIDGE HOME OFFICE ONE-CLICK
echo =======================================================
echo   Recover from approved credentials or pair with explicit owner confirmation.
echo   Owner browser approval is required for first pairing.
echo   No global policy bypass, admin elevation or project changes.
echo.
if /I not "%OS%"=="Windows_NT" goto :wrong_os
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :wrong_pc
set "KMJ_CB_HOST=DESKTOP-5FVJMET"
set "KMJ_CB_SHA=4b6eee169b057451d3e512cd0197be08879bf8f6"
set "KMJ_CB_SOURCE=https://github.com/kmjtechno/kmj-codebridge.git"
set "KMJ_CB_CMD=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%KMJ_CB_CMD%" goto :missing_powershell
if exist "%LOCALAPPDATA%\KMJ-CodeBridge\private\homeoffice-calibration-pro\enrollment.json" if not exist "%LOCALAPPDATA%\KMJ-CodeBridge\private\homeoffice-calibration-pro\agent.json" goto :partial_enrollment
if not exist "%LOCALAPPDATA%\KMJ-CodeBridge\private\homeoffice-calibration-pro\agent.json" (
  echo DEVICE_RECOVERY=NO_LOCAL_AGENT_CONFIG
  echo The old server registration must be disconnected by the owner if present.
  echo This launcher never revokes any device, changes credentials or bypasses approval.
  start "" "https://kmjtechno.com/services/kmj-codebridge#codebridge-device-control"
  choice /C YN /N /M "Have you disconnected ONLY DESKTOP-5FVJMET in the dashboard (Y/N)? "
  if errorlevel 2 goto :owner_confirmation_missing
  echo OWNER_REVOKE_CONFIRMATION=YES_AT_CONSOLE_NOT_SERVER_VERIFIED
)
"%KMJ_CB_CMD%" -NoProfile -STA -ExecutionPolicy RemoteSigned -Command "& { try { $ErrorActionPreference='Stop'; function Mark($a,$b){Write-Output ($a+'='+$b)}; function Fail($code){Mark 'CODEBRIDGE_ONECLICK' ('BLOCKED_'+$code); exit 2}; $git=(Get-Command git.exe -ErrorAction SilentlyContinue); $node=(Get-Command node.exe -ErrorAction SilentlyContinue); $npm=(Get-Command npm.cmd -ErrorAction SilentlyContinue); if(!$git){Fail 'GIT_MISSING'}; if(!$node -or !$npm){Fail 'NODE24_OR_NPM_MISSING'}; $ver=[string](& $node.Source --version); if($LASTEXITCODE -ne 0 -or $ver -notmatch '^v([0-9]+)\.' -or [int]$Matches[1] -lt 24){Fail 'NODE24_REQUIRED'}; $roots=@('E:\KMJ\CodeBridge-HomeOffice','E:\KMJ\CodeBridge-HomeOffice-Connect-v2','E:\KMJ\CodeBridge','E:\KMJ\kmj-codebridge','D:\KMJ-HyperSpeed',(Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\runtimes\CodeBridge-HomeOffice-Connect-v2')); $allowed=@('https://github.com/kmjtechno/kmj-codebridge.git','https://github.com/kmjtechno/kmj-codebridge','git@github.com:kmjtechno/kmj-codebridge.git'); function Check($p){ try{$ErrorActionPreference='Continue'; if(!(Test-Path -LiteralPath $p -PathType Container)){return $false}; $it=Get-Item -LiteralPath $p; while($it){if($it.Attributes -band [IO.FileAttributes]::ReparsePoint){return $false};$it=$it.Parent}; if(!(Test-Path -LiteralPath (Join-Path $p 'src\cli.js') -PathType Leaf)){return $false}; $o=[string]((& $git.Source -C $p remote get-url origin 2>$null) | Select-Object -First 1); if($LASTEXITCODE -ne 0 -or $o.Trim() -cnotin $allowed){return $false}; $top=[string]((& $git.Source -C $p rev-parse --show-toplevel 2>$null) | Select-Object -First 1); if($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($top).TrimEnd([char]92) -ine [IO.Path]::GetFullPath($p).TrimEnd([char]92)){return $false}; $actual=[string]((& $git.Source -C $p rev-parse HEAD 2>$null) | Select-Object -First 1); if($LASTEXITCODE -ne 0 -or $actual.Trim() -cne $env:KMJ_CB_SHA){return $false}; $dirty=@(& $git.Source --no-optional-locks -C $p status --porcelain=v1 --untracked-files=no 2>$null); if($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){return $false}; $req=@('scripts/windows/ONE-CLICK-AGENT-AUTOCONNECT.ps1','scripts/windows/CONNECT-CALIBRATION-PRO.ps1','scripts/windows/PAIR-HOMEOFFICE-CALIBRATION.ps1'); foreach($s in $req){if(!(Test-Path -LiteralPath (Join-Path $p $s) -PathType Leaf)){return $false}}; $tracked=@(& $git.Source -C $p ls-tree -r --name-only HEAD -- @req 2>$null); if($LASTEXITCODE -ne 0 -or $tracked.Count -ne 3){return $false}; return (Test-Path -LiteralPath (Join-Path $p 'node_modules\zod\package.json') -PathType Leaf) }catch{return $false} }; $runtime=$null; foreach($p in $roots){if(Check $p){$runtime=$p;break}}; if($null -ne $runtime){Mark 'CODEBRIDGE_RUNTIME' 'REUSED_EXISTING_TRACKED_CLEAN'}else{ $base=if(Test-Path -LiteralPath 'E:\KMJ' -PathType Container){'E:\KMJ'}else{Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\runtimes'}; $dest=Join-Path $base 'CodeBridge-HomeOffice-Connect-v2'; if(Test-Path -LiteralPath 'E:\KMJ\CodeBridge-HomeOffice'){Mark 'CODEBRIDGE_DISCOVERY' 'OLD_RUNTIME_PRESERVED'}; if(Test-Path -LiteralPath $dest){Fail 'CONNECT_RUNTIME_EXISTS_REVIEW_REQUIRED'}; if(!(Test-Path -LiteralPath $base)){New-Item -ItemType Directory -Path $base -ErrorAction Stop | Out-Null}; $temp=Join-Path $base ('CodeBridge-stage-'+[guid]::NewGuid().ToString('N')); Mark 'CODEBRIDGE_INSTALL' 'PINNED_CLEAN_SOURCE'; & $git.Source clone --depth 1 --single-branch --branch main --no-checkout --no-tags $env:KMJ_CB_SOURCE $temp; if($LASTEXITCODE -ne 0){Fail 'CLONE_FAILED'}; & $git.Source -C $temp fetch --depth 1 --no-tags origin $env:KMJ_CB_SHA; if($LASTEXITCODE -ne 0){Fail 'PINNED_FETCH_FAILED'}; & $git.Source -C $temp checkout --detach $env:KMJ_CB_SHA; if($LASTEXITCODE -ne 0){Fail 'PINNED_CHECKOUT_FAILED'}; $head=[string]((& $git.Source -C $temp rev-parse HEAD) | Select-Object -First 1); if($head.Trim() -cne $env:KMJ_CB_SHA){Fail 'HEAD_MISMATCH'}; Push-Location -LiteralPath $temp; try{& $npm.Source ci --ignore-scripts --no-audit --no-fund; if($LASTEXITCODE -ne 0){Fail 'NPM_INSTALL_FAILED'}}finally{Pop-Location}; if(!(Check $temp)){Fail 'STAGED_RUNTIME_UNTRUSTED'}; if(Test-Path -LiteralPath $dest){Fail 'DESTINATION_EXISTS_NO_OVERWRITE'}; Move-Item -LiteralPath $temp -Destination $dest -ErrorAction Stop; if(!(Check $dest)){Fail 'PROMOTION_UNTRUSTED'}; $runtime=$dest; Mark 'CODEBRIDGE_RUNTIME' 'NEW_PINNED_INSTALL'}; $actualHead=[string]((& $git.Source -C $runtime rev-parse HEAD) | Select-Object -First 1); Mark 'CODEBRIDGE_RUNTIME_HEAD' $actualHead.Trim(); $script=Join-Path $runtime 'scripts\windows\ONE-CLICK-AGENT-AUTOCONNECT.ps1'; Mark 'CODEBRIDGE_NEXT' 'OWNER_PAIRING_OR_RECONNECT'; & $script -Device HomeOffice; if($LASTEXITCODE -ne 0){Fail 'CONNECT_OR_PAIRING_NOT_VERIFIED'}; Mark 'CODEBRIDGE_LOCAL' 'CONNECT_LAUNCHER_SUCCEEDED'; Mark 'CODEBRIDGE_GATEWAY_READY' 'NOT_ATTESTED_VERIFY_IN_CHAT' } catch { Mark 'CODEBRIDGE_ONECLICK' 'BLOCKED_LOCAL_VALIDATION_OR_NETWORK'; exit 2 } }"
set "RC=%ERRORLEVEL%"
echo.
echo CODEBRIDGE_ONECLICK_EXIT=%RC%
echo Account-side READY is checked in ChatGPT after this step.
echo Do not share enrollment tokens, agent.json or raw private logs.
pause
exit /b %RC%

:partial_enrollment
echo CODEBRIDGE_ONECLICK=BLOCKED_EXISTING_PRIVATE_ENROLLMENT_REVIEW_REQUIRED
echo Enrollment exists without agent.json. Do not revoke or erase it.
pause
exit /b 2
:owner_confirmation_missing
echo CODEBRIDGE_ONECLICK=OWNER_CONFIRMATION_REQUIRED_NO_CHANGES
pause
exit /b 2
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
