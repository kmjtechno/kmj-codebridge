# KMJ TECHNO: owner P520 one-time hourly signed-release task setup.
# Source-only pending review. No key copy, agent restart or production switch.
[CmdletBinding()]
param([switch]$Apply,[switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$TaskName='KMJ-CodeBridge-Owner-Auto-Sign'
$HostName='DESKTOP-5FVJMET'
$Install=Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\OwnerSigner'
$Source=Join-Path $PSScriptRoot '..\production\owner-auto-sign-stable.mjs'
$SourceGate=Join-Path $PSScriptRoot '..\release-ci-gate.mjs'
$Signer=Join-Path $Install 'scripts\production\owner-auto-sign-stable.mjs'
$Gate=Join-Path $Install 'scripts\release-ci-gate.mjs'
$Policy=Join-Path $HOME '.config\kmj-codebridge\auto-sign-policy.json'
$SignerBlob='4382d2f4db1edf768cdfcfefde11e2ea6d95587b'
$GateBlob='897d9ff674ac6d007bae34084060a16b713ef2b6'
function Mark([string]$n,[string]$v){Write-Output ($n+'='+$v)}
function Need([bool]$ok,[string]$code){if(-not $ok){throw $code}}
function FileSafe([string]$p){
  if(-not(Test-Path -LiteralPath $p -PathType Leaf)){return $false}
  return (((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function OwnerAcl([string]$p,[string]$owner){
  $acl=Get-Acl -LiteralPath $p -ErrorAction Stop
  Need $acl.AreAccessRulesProtected 'OWNER_FILE_ACL_INHERITED'
  $allowed=@($owner,'S-1-5-18','S-1-5-32-544')
  $found=$false
  foreach($ace in @($acl.Access)){
    $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    Need ($sid -in $allowed -and [string]$ace.AccessControlType -ceq 'Allow') 'OWNER_FILE_ACL_UNSAFE'
    if($sid -ceq $owner){$found=$true}
  }
  Need $found 'OWNER_FILE_ACL_MISSING_OWNER'
}
if($SelfTest){
  Need (-not(FileSafe '')) 'SELFTEST_MISSING_PATH'
  Mark 'OWNER_AUTOSIGN_SETUP_SELFTEST' 'PASS'
  exit 0
}
try{
  Need ($env:OS -ceq 'Windows_NT' -and $env:COMPUTERNAME -ieq $HostName) 'WRONG_OWNER_HOST'
  $git=(Get-Command git.exe -ErrorAction Stop).Source
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  $major=([string](& $node --version)).TrimStart('v').Split('.')[0]
  Need ($LASTEXITCODE -eq 0 -and [int]$major -ge 24) 'NODE24_REQUIRED'
  foreach($pair in @(@($Source,$SignerBlob),@($SourceGate,$GateBlob))){
    Need (FileSafe ([string]$pair[0])) 'REVIEWED_SOURCE_MISSING'
    $hash=([string](& $git hash-object -- ([string]$pair[0]))).Trim()
    Need ($LASTEXITCODE -eq 0 -and $hash -ceq [string]$pair[1]) 'SOURCE_BLOB_NOT_PINNED'
  }
  Need (FileSafe $Policy) 'ONE_TIME_OWNER_POLICY_MISSING'
  $p=Get-Content -LiteralPath $Policy -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
  Need ([int]$p.schema -eq 1 -and $p.enabled -eq $true -and
    [string]$p.profile -ceq 'owner-host-auto-sign-stable-only' -and
    [string]$p.ownerConsent -ceq 'AUTO_SIGN_REVIEWED_MAIN_ONLY' -and
    [string]$p.repo -ceq 'kmjtechno/kmj-codebridge' -and
    [string]$p.keyId -ceq 'kmj-release-2026') 'OWNER_POLICY_INVALID'
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  OwnerAcl $Policy $sid
  Need (FileSafe ([string]$p.keyFile)) 'OWNER_PRIVATE_KEY_MISSING'
  OwnerAcl ([string]$p.keyFile) $sid
  Need (FileSafe ([string]$p.publicKeyFile)) 'OWNER_PUBLIC_KEY_MISSING'
  OwnerAcl ([string]$p.publicKeyFile) $sid
  Need (-not(Test-Path -LiteralPath $Install)) 'SIGNER_INSTALL_ALREADY_PRESENT'
  $existing=@(Get-ScheduledTask -ErrorAction Stop|Where-Object{$_.TaskName -ieq $TaskName})
  Need ($existing.Count -eq 0) 'AUTOSIGN_TASK_ALREADY_PRESENT'
  Mark 'OWNER_AUTOSIGN_PREFLIGHT' 'PASS'
  Mark 'OWNER_AUTOSIGN_PRIVATE_KEY' 'LOCAL_ONLY'
  if(-not $Apply){Mark 'OWNER_AUTOSIGN_SETUP' 'DRY_RUN_PASS';exit 0}
  New-Item -ItemType Directory -Path (Join-Path $Install 'scripts\production') -Force -ErrorAction Stop|Out-Null
  Copy-Item -LiteralPath $Source -Destination $Signer -ErrorAction Stop
  Copy-Item -LiteralPath $SourceGate -Destination $Gate -ErrorAction Stop
  $aclArgs=@($Install,'/inheritance:r','/grant:r',('*'+$sid+':(OI)(CI)F'),'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F','/T','/Q')
  & icacls.exe @aclArgs 1>$null
  Need ($LASTEXITCODE -eq 0) 'INSTALL_ACL_NOT_VERIFIED'
  foreach($pair in @(@($Signer,$SignerBlob),@($Gate,$GateBlob))){
    $hash=([string](& $git hash-object -- ([string]$pair[0]))).Trim()
    Need ($LASTEXITCODE -eq 0 -and $hash -ceq [string]$pair[1]) 'INSTALLED_SOURCE_HASH_DRIFT'
  }
  $action=New-ScheduledTaskAction -Execute $node -Argument ('"'+$Signer+'" --once') -WorkingDirectory $Install
  $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop|Out-Null
  $task=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  Need ([string]$task.State -in @('Ready','Running') -and [string]$task.Principal.RunLevel -ceq 'Limited' -and [string]$task.Principal.LogonType -ceq 'Interactive' -and @($task.Actions).Count -eq 1) 'TASK_READBACK_UNVERIFIED'
  Mark 'OWNER_AUTOSIGN_TASK' 'ENABLED_HOURLY'
  Mark 'OWNER_AUTOSIGN_SIGNER' 'OWNER_HOST_ONLY'
  Mark 'OWNER_AUTOSIGN_SETUP' 'PASS'
}catch{
  $reason=[string]$_.Exception.Message
  if($reason -cnotmatch '^[A-Z][A-Z0-9_]{3,90}$'){$reason='OWNER_REVIEW_REQUIRED'}
  Mark 'OWNER_AUTOSIGN_SETUP' ('BLOCKED:'+$reason)
  Mark 'OWNER_AUTOSIGN_PRIVATE_KEY' 'UNTOUCHED'
  exit 2
}
