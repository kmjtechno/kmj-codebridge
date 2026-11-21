# KMJ universal Windows one-click from ANY trusted CodeBridge checkout.
# Clones exact checked-out source commit into isolated current-user runtime.
# Never resets/cleans the owner's dirty project or runs a privileged task.
[CmdletBinding()]
param([string]$ProjectRoot,[switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Mark([string]$key,[string]$value){Write-Output ($key+'='+$value)}
function Require([bool]$ok,[string]$reason){if(-not $ok){throw $reason}}
function Regular([string]$p){
  if(-not(Test-Path -LiteralPath $p -PathType Leaf)){return $false}
  return (((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function Directory([string]$p){
  if(-not(Test-Path -LiteralPath $p -PathType Container)){return $false}
  return (((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function GitValue([string]$git,[string]$root,[string[]]$gitArgs){
  $value=@(& $git -C $root @gitArgs 2>$null)
  Require ($LASTEXITCODE -eq 0 -and $value.Count -eq 1) 'GIT_QUERY_FAILED'
  return ([string]$value[0]).Trim()
}
function TrustedSource([string]$git,[string]$source){
  $origin=GitValue $git $source @('remote','get-url','origin')
  Require ($origin -cin @(
    'https://github.com/kmjtechno/kmj-codebridge',
    'https://github.com/kmjtechno/kmj-codebridge.git',
    'git@github.com:kmjtechno/kmj-codebridge.git'
  )) 'SOURCE_ORIGIN_INVALID'
  $top=GitValue $git $source @('rev-parse','--show-toplevel')
  Require ([IO.Path]::GetFullPath($top).TrimEnd('\') -ieq $source.TrimEnd('\')) 'SOURCE_REPO_ROOT_MISMATCH'
  $sha=GitValue $git $source @('rev-parse','HEAD')
  Require ($sha -cmatch '^[a-f0-9]{40}$') 'SOURCE_SHA_INVALID'
  # The entrypoint itself must be the committed, clean source, even when the
  # owner's other working files in the repository are modified or untracked.
  foreach($name in @('KMJ-ONE-CLICK.cmd','scripts/windows/ONE-CLICK-ISOLATED-DEVICE.ps1')){
    $expected=GitValue $git $source @('rev-parse',('HEAD:'+$name))
    $local=([string](& $git hash-object (Join-Path $source $name) 2>$null)).Trim()
    Require ($LASTEXITCODE -eq 0 -and $local -ceq $expected) 'ENTRY_SOURCE_MODIFIED'
  }
  return $sha
}
function TrustedRuntime([string]$git,[string]$target,[string]$sha){
  Require (Directory $target) 'STAGED_RUNTIME_MISSING_OR_LINKED'
  Require (Directory (Join-Path $target '.git')) 'STAGED_GIT_MISSING'
  Require ((GitValue $git $target @('rev-parse','HEAD')) -ceq $sha) 'STAGED_SHA_MISMATCH'
  Require ((GitValue $git $target @('remote','get-url','origin')) -ceq 'https://github.com/kmjtechno/kmj-codebridge.git') 'STAGED_ORIGIN_MISMATCH'
  $dirty=@(& $git --no-optional-locks -C $target status --porcelain=v1 --untracked-files=no 2>$null)
  Require ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'STAGED_RUNTIME_DIRTY'
  foreach($file in @(
    (Join-Path $target 'src\cli.js'),
    (Join-Path $target 'scripts\windows\ONE-CLICK-ANY-DEVICE.ps1'),
    (Join-Path $target 'scripts\enroll-device.js'),
    (Join-Path $target 'node_modules\zod\package.json'),
    (Join-Path $target 'node_modules\jose\package.json')
  )) {Require (Regular $file) 'STAGED_RUNTIME_INCOMPLETE'}
}
if($SelfTest){
  Require (([IO.Path]::GetFullPath('C:\A\B').TrimEnd('\')) -ceq 'C:\A\B') 'SELFTEST_PATH'
  Mark 'KMJ_UNIVERSAL_WINDOWS_STAGE_SELFTEST' 'PASS'
  exit 0
}
try{
  Require ($env:OS -ceq 'Windows_NT') 'WINDOWS_ONLY'
  Require (![string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) 'USER_LOCALAPPDATA_REQUIRED'
  $source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  Require (Directory $source) 'SOURCE_DIRECTORY_UNSAFE'
  $entry=Join-Path $PSScriptRoot 'ONE-CLICK-ISOLATED-DEVICE.ps1'
  Require (Regular $entry) 'SOURCE_SCRIPT_LINKED_OR_MISSING'
  $git=(Get-Command git.exe -ErrorAction Stop).Source
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  $npm=(Get-Command npm.cmd -ErrorAction Stop).Source
  $nodeVersion=([string](& $node --version)).Trim()
  Require ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^v(2[4-9]|[3-9][0-9])\.') 'NODE24_REQUIRED'
  $sha=TrustedSource $git $source
  $base=Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\managed-runtimes'
  $target=Join-Path $base $sha
  if(Test-Path -LiteralPath $base){
    Require (Directory $base) 'STAGE_PARENT_UNSAFE'
  }else{New-Item -ItemType Directory -Path $base -Force -ErrorAction Stop|Out-Null}
  if(Test-Path -LiteralPath $target){
    TrustedRuntime $git $target $sha
    Mark 'KMJ_UNIVERSAL_RUNTIME' 'REUSED_VERIFIED'
  }else{
    $candidate=Join-Path $base ($sha+'.candidate-'+[guid]::NewGuid().ToString('N'))
    Require (-not(Test-Path -LiteralPath $candidate)) 'STAGE_COLLISION'
    & $git clone --no-checkout --quiet 'https://github.com/kmjtechno/kmj-codebridge.git' $candidate 2>$null
    Require ($LASTEXITCODE -eq 0) 'STAGE_CLONE_FAILED'
    & $git -C $candidate checkout --quiet --detach $sha 2>$null
    Require ($LASTEXITCODE -eq 0) 'STAGE_EXACT_SHA_UNAVAILABLE'
    Require ((GitValue $git $candidate @('rev-parse','HEAD')) -ceq $sha) 'STAGE_SHA_INVALID'
    & $npm --prefix $candidate ci --omit=dev --ignore-scripts --no-audit --no-fund
    Require ($LASTEXITCODE -eq 0) 'STAGE_NPM_FAILED'
    TrustedRuntime $git $candidate $sha
    Require (-not(Test-Path -LiteralPath $target)) 'STAGE_RACE_EXISTING_TARGET'
    Move-Item -LiteralPath $candidate -Destination $target -ErrorAction Stop
    TrustedRuntime $git $target $sha
    Mark 'KMJ_UNIVERSAL_RUNTIME' 'STAGED_EXACT_SHA'
  }
  $wizard=Join-Path $target 'scripts\windows\ONE-CLICK-ANY-DEVICE.ps1'
  Require (Regular $wizard) 'WIZARD_MISSING'
  if([string]::IsNullOrWhiteSpace($ProjectRoot)){
    & powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File $wizard
  }else{
    Require ([IO.Path]::IsPathRooted($ProjectRoot) -and (Directory $ProjectRoot)) 'PROJECT_NOT_DIRECTORY'
    & powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File $wizard -ProjectRoot ([IO.Path]::GetFullPath($ProjectRoot))
  }
  Require ($LASTEXITCODE -eq 0) 'APPROVED_WIZARD_BLOCKED'
  Mark 'KMJ_DEVICE_ONE_CLICK' 'LOCAL_FLOW_COMPLETED'
  Mark 'KMJ_ACCOUNT_READY' 'CHECK_AUTHENTICATED_CONNECTION_OVERVIEW'
}catch{
  $reason=[string]$_.Exception.Message
  if($reason -cnotmatch '^[A-Z][A-Z0-9_]{3,100}$'){$reason='REVIEW_REQUIRED'}
  Mark 'KMJ_DEVICE_ONE_CLICK' ('BLOCKED_'+$reason)
  Mark 'KMJ_OWNER_PROJECT' 'UNTOUCHED'
  exit 2
}
