# KMJ TECHNO — owner-only, fail-closed upgrade of an ALREADY installed signer.
# Do not copy/read private keys or modify release approval. Never replace an unknown task.
# SAFETY HOLD: this maintenance tool accepts ONLY an already-disabled task.
# It never enables, starts, or schedules signing.
[CmdletBinding()]
param([switch]$Apply,[switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$TaskName='KMJ-CodeBridge-Owner-Auto-Sign'
$ExpectedHost='DESKTOP-5FVJMET'
$Install=Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\OwnerSigner'
$Signer=Join-Path $Install 'scripts\production\owner-auto-sign-stable.mjs'
$Gate=Join-Path $Install 'scripts\release-ci-gate.mjs'
$Source=Join-Path $PSScriptRoot '..\production\owner-auto-sign-stable.mjs'
$Policy=Join-Path $HOME '.config\kmj-codebridge\auto-sign-policy.json'
$OldSignerBlob='a41985b2b407bebd34ddb5bfa8f010bf4e11ffb1'
$IntermediateSignerBlob='b3717a8b3c948567f6648ad11233ed276d58b143'
$NewSignerBlob='1af22ec588966fdebd02f178721cc35121580346'
$GateBlob='897d9ff674ac6d007bae34084060a16b713ef2b6'
$Candidate=$Signer+'.upgrade-candidate-20261119'
$Backup=$Signer+'.pre-upgrade-20261119'
function Need([bool]$ok,[string]$code){if(-not $ok){throw $code}}
function Mark([string]$key,[string]$value){Write-Output ($key+'='+$value)}
function SafeFile([string]$p){
  if(-not(Test-Path -LiteralPath $p -PathType Leaf)){return $false}
  return (((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function OwnerAcl([string]$p,[string]$sid) {
  $a=Get-Acl -LiteralPath $p -ErrorAction Stop
  Need ($a.AreAccessRulesProtected) 'UPGRADE_ACL_INHERITED'
  Need ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $sid) 'UPGRADE_OWNER_MISMATCH'
  $allowed=@($sid,'S-1-5-18','S-1-5-32-544')
  $found=$false
  foreach($ace in @($a.Access)) {
    $who=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    Need ($who -in $allowed -and
      [string]$ace.AccessControlType -ceq 'Allow') 'UPGRADE_ACL_UNSAFE'
    if($who -ceq $sid){$found=$true}
  }
  Need $found 'UPGRADE_OWNER_ACE_MISSING'
}
function GitBlob([string]$p,[string]$git) {
  $h=([string](& $git hash-object -- $p)).Trim()
  Need ($LASTEXITCODE -eq 0 -and $h -match '^[a-f0-9]{40}$') 'UPGRADE_HASH_UNVERIFIED'
  return $h
}
if($SelfTest) {
  $caught=$false
  try{Need $false 'UPGRADE_DENIAL_SELFTEST'}catch{
    $caught=([string]$_.Exception.Message -ceq 'UPGRADE_DENIAL_SELFTEST')
  }
  Need $caught 'UPGRADE_SELFTEST_FAIL'
  Mark 'OWNER_AUTOSIGN_UPGRADE_SELFTEST' 'PASS'
  exit 0
}
try {
  Need ($env:OS -ceq 'Windows_NT' -and
    $env:COMPUTERNAME -ieq $ExpectedHost) 'UPGRADE_WRONG_HOST'
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $git=(Get-Command git.exe -ErrorAction Stop).Source
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  Need (SafeFile $Source) 'UPGRADE_PINNED_SOURCE_MISSING'
  Need ((GitBlob $Source $git) -ceq $NewSignerBlob) 'UPGRADE_SOURCE_NOT_PINNED'
  Need (SafeFile $Policy) 'UPGRADE_OWNER_POLICY_MISSING'
  OwnerAcl $Policy $sid
  $policy=Get-Content -LiteralPath $Policy -Raw -ErrorAction Stop |
    ConvertFrom-Json -ErrorAction Stop
  Need ($policy.enabled -eq $true -and
    [string]$policy.ownerConsent -ceq 'AUTO_SIGN_REVIEWED_MAIN_ONLY' -and
    [string]$policy.repo -ceq 'kmjtechno/kmj-codebridge' -and
    [string]$policy.keyId -ceq 'kmj-release-2026' -and
    [datetime]::UtcNow -lt ([datetime]::Parse([string]$policy.expiresAt)).ToUniversalTime()
  ) 'UPGRADE_OWNER_CONSENT_INVALID'
  Need (Test-Path -LiteralPath $Install -PathType Container) 'UPGRADE_INSTALL_MISSING'
  foreach($dir in @($Install,(Join-Path $Install 'scripts'),
        (Join-Path $Install 'scripts\production'))) {
    $d=Get-Item -LiteralPath $dir -Force -ErrorAction Stop
    Need ($d.PSIsContainer -and
      ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'UPGRADE_DIRECTORY_UNTRUSTED'
    OwnerAcl $dir $sid
  }
  Need ((SafeFile $Signer) -and (SafeFile $Gate)) 'UPGRADE_INSTALLED_FILES_MISSING'
  OwnerAcl $Signer $sid
  OwnerAcl $Gate $sid
  Need ((GitBlob $Gate $git) -ceq $GateBlob) 'UPGRADE_CI_GATE_DRIFT'
  $existing=(GitBlob $Signer $git)
  Need ($existing -in @($OldSignerBlob,$IntermediateSignerBlob,$NewSignerBlob)) 'UPGRADE_SIGNER_UNRECOGNIZED'
  $task=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  $actions=@($task.Actions)
  Need ($actions.Count -eq 1 -and
    [string]$task.Principal.UserId -ieq $identity -and
    [string]$task.Principal.RunLevel -ceq 'Limited' -and
    [string]$task.Principal.LogonType -ceq 'Interactive' -and
    [string]$actions[0].Execute -ieq $node -and
    [string]$actions[0].Arguments -ceq ('"'+$Signer+'" --once') -and
    [string]$actions[0].WorkingDirectory -ieq $Install) 'UPGRADE_TASK_IDENTITY_UNVERIFIED'
  Need ([string]$task.State -ceq 'Disabled') 'UPGRADE_TASK_NOT_DISABLED'
  if($existing -ceq $NewSignerBlob) {
    Mark 'OWNER_AUTOSIGN_UPGRADE' 'ALREADY_CURRENT'
    exit 0
  }
  Need (-not(Test-Path -LiteralPath $Candidate) -and
    -not(Test-Path -LiteralPath $Backup)) 'UPGRADE_PREVIOUS_ARTIFACT_PRESENT'
  Mark 'OWNER_AUTOSIGN_UPGRADE_PREFLIGHT' 'PASS'
  if(-not $Apply) {
    Mark 'OWNER_AUTOSIGN_UPGRADE' 'DRY_RUN_ONLY'
    exit 0
  }
  # Stage and verify only after the owner has independently disabled the task.
  # A failing stage cannot alter the scheduled action or original signer.
  Copy-Item -LiteralPath $Source -Destination $Candidate -ErrorAction Stop
  & icacls.exe $Candidate /inheritance:r /grant:r ('*'+$sid+':F') '*S-1-5-18:F' '*S-1-5-32-544:F' 1>$null
  Need ($LASTEXITCODE -eq 0) 'UPGRADE_CANDIDATE_ACL_FAILED'
  Need (SafeFile $Candidate) 'UPGRADE_CANDIDATE_FILE_UNTRUSTED'
  OwnerAcl $Candidate $sid
  Need ((GitBlob $Candidate $git) -ceq $NewSignerBlob) 'UPGRADE_CANDIDATE_HASH_DRIFT'
  # Recheck the owner-maintained safety hold immediately before replacement.
  $before=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  Need ([string]$before.State -ceq 'Disabled') 'UPGRADE_TASK_NOT_DISABLED_AT_REPLACE'
  # Same-volume NTFS replacement atomically stores the known-good old file
  # in a protected backup. Preserve it for an owner-controlled rollback.
  [System.IO.File]::Replace($Candidate,$Signer,$Backup)
  Need (SafeFile $Signer) 'UPGRADE_REPLACEMENT_UNTRUSTED'
  OwnerAcl $Signer $sid
  Need ((GitBlob $Signer $git) -ceq $NewSignerBlob) 'UPGRADE_REPLACED_HASH_DRIFT'
  Need (SafeFile $Backup) 'UPGRADE_ROLLBACK_BACKUP_MISSING'
  OwnerAcl $Backup $sid
  Need ((GitBlob $Backup $git) -ceq $existing) 'UPGRADE_ROLLBACK_BACKUP_DRIFT'
  $disabled=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  Need ([string]$disabled.State -ceq 'Disabled' -and
    @($disabled.Actions).Count -eq 1 -and
    [string]$disabled.Actions[0].Arguments -ceq ('"'+$Signer+'" --once') -and
    [string]$disabled.Actions[0].WorkingDirectory -ieq $Install
  ) 'UPGRADE_DISABLED_READBACK_UNVERIFIED'
  Mark 'OWNER_AUTOSIGN_UPGRADE' 'PASS'
  Mark 'OWNER_AUTOSIGN_SIGNER_BLOB' $NewSignerBlob
  Mark 'OWNER_AUTOSIGN_TASK' 'DISABLED_PRESERVED'
  Mark 'OWNER_AUTOSIGN_OLD_SIGNER' 'PRESERVED_FOR_ROLLBACK'
} catch {
  # No automatic reenable on success or failure. Preserve explicit owner hold.
  try {
    $d=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
    if([string]$d.State -ceq 'Disabled'){
      Mark 'OWNER_AUTOSIGN_TASK' 'DISABLED_PRESERVED'
    }else{
      Mark 'OWNER_AUTOSIGN_TASK' 'REVIEW_REQUIRED'
    }
  }catch{Mark 'OWNER_AUTOSIGN_TASK' 'REVIEW_REQUIRED'}
  $reason=[string]$_.Exception.Message
  if($reason -cnotmatch '^[A-Z][A-Z0-9_]{3,90}$'){
    $reason='UPGRADE_OWNER_REVIEW_REQUIRED'
  }
  Mark 'OWNER_AUTOSIGN_UPGRADE' ('BLOCKED:'+$reason)
  Mark 'OWNER_AUTOSIGN_PRIVATE_KEY' 'UNTOUCHED'
  exit 2
}