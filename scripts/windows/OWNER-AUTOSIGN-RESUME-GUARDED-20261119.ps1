# KMJ TECHNO P520 — guarded enable of a previously approved owner signer.
# This does NOT sign now; it only resumes the existing hourly task.
# Key bytes are never read by this script. Separate GitHub review/CI gates apply.
[CmdletBinding()]
param([switch]$Apply,[switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$TaskName='KMJ-CodeBridge-Owner-Auto-Sign'
$ExpectedHost='DESKTOP-5FVJMET'
$ExpectedBlob='31c58d25baa2d57945a70fe689c54979b8023229'
$Signer=Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\OwnerSigner\scripts\production\owner-auto-sign-stable.mjs'
$Install=Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\OwnerSigner'
$Policy=Join-Path $HOME '.config\kmj-codebridge\auto-sign-policy.json'
$ExpectedChecks=@('registry_manifest','clients','distribution','verify (ubuntu-24.04)','verify (windows-latest)')
function Need([bool]$ok,[string]$reason){if(-not $ok){throw $reason}}
function Mark([string]$k,[string]$v){Write-Output ($k+'='+$v)}
function SafeFile([string]$p){
  if(-not(Test-Path -LiteralPath $p -PathType Leaf)){return $false}
  $f=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  return (($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function PrivateOwnerAcl([string]$p,[string]$sid){
  $a=Get-Acl -LiteralPath $p -ErrorAction Stop
  Need ($a.AreAccessRulesProtected -and
    $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $sid) 'AUTOSIGN_OWNER_ACL_NOT_PRIVATE'
  $allowed=@($sid,'S-1-5-18','S-1-5-32-544')
  $found=$false
  foreach($ace in @($a.Access)){
    $owner=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    Need ($owner -in $allowed -and
      [string]$ace.AccessControlType -ceq 'Allow') 'AUTOSIGN_OWNER_ACL_UNSAFE'
    if($owner -ceq $sid){$found=$true}
  }
  Need $found 'AUTOSIGN_OWNER_ACL_MISSING'
}
function GhJson([string]$resource){
  $output=@(& gh.exe api $resource 2>$null)
  Need ($LASTEXITCODE -eq 0 -and $output.Count -gt 0) 'AUTOSIGN_GITHUB_API_UNAVAILABLE'
  try {return ($output -join "`n") | ConvertFrom-Json -ErrorAction Stop}
  catch {throw 'AUTOSIGN_GITHUB_JSON_UNVERIFIED'}
}
if($SelfTest) {
  $denied=$false
  try{Need $false 'AUTOSIGN_GUARDED_SELFTEST'}catch{$denied=([string]$_.Exception.Message -ceq 'AUTOSIGN_GUARDED_SELFTEST')}
  Need $denied 'AUTOSIGN_SELFTEST_FAILED'
  Mark 'OWNER_AUTOSIGN_RESUME_SELFTEST' 'PASS'
  exit 0
}
try {
  Need ($env:OS -ceq 'Windows_NT' -and
    $env:COMPUTERNAME -ieq $ExpectedHost) 'AUTOSIGN_WRONG_HOST'
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  Need (SafeFile $Signer) 'AUTOSIGN_PINNED_SIGNER_MISSING'
  Need (SafeFile $Policy) 'AUTOSIGN_OWNER_POLICY_MISSING'
  PrivateOwnerAcl $Signer $sid
  PrivateOwnerAcl $Policy $sid
  $git=(Get-Command git.exe -ErrorAction Stop).Source
  $blob=([string](& $git hash-object -- $Signer)).Trim()
  Need ($LASTEXITCODE -eq 0 -and $blob -ceq $ExpectedBlob) 'AUTOSIGN_SIGNER_BLOB_NOT_APPROVED'
  $policy=Get-Content -LiteralPath $Policy -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
  Need ($policy.enabled -eq $true -and
    [string]$policy.ownerConsent -ceq 'AUTO_SIGN_REVIEWED_MAIN_ONLY' -and
    [string]$policy.repo -ceq 'kmjtechno/kmj-codebridge' -and
    [string]$policy.keyId -ceq 'kmj-release-2026' -and
    [datetime]::UtcNow -ge ([datetime]::Parse([string]$policy.approvedAt)).ToUniversalTime() -and
    [datetime]::UtcNow -lt ([datetime]::Parse([string]$policy.expiresAt)).ToUniversalTime()
  ) 'AUTOSIGN_OWNER_POLICY_NOT_APPROVED'
  $task=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  $actions=@($task.Actions)
  Need ([string]$task.State -ceq 'Disabled' -and $actions.Count -eq 1 -and
    [string]$task.Principal.UserId -ieq $identity -and
    [string]$task.Principal.RunLevel -ceq 'Limited' -and
    [string]$task.Principal.LogonType -ceq 'Interactive' -and
    [string]$actions[0].Arguments -ceq ('"'+$Signer+'" --once') -and
    [string]$actions[0].WorkingDirectory -ieq $Install) 'AUTOSIGN_TASK_NOT_OWNER_DISABLED'
  $binary=[string]$actions[0].Execute
  Need (SafeFile $binary) 'AUTOSIGN_TASK_RUNTIME_NOT_TRUSTED'
  $major=([string](& $binary -p 'process.versions.node.split(".")[0]')).Trim()
  Need ($LASTEXITCODE -eq 0 -and [int]$major -ge 24) 'AUTOSIGN_TASK_NODE24_REQUIRED'
  $repo=GhJson 'repos/kmjtechno/kmj-codebridge'
  Need ($repo.allow_auto_merge -eq $true -and
    $repo.allow_squash_merge -eq $true -and
    [string]$repo.default_branch -ceq 'main') 'AUTOSIGN_REPO_MERGE_POLICY_UNVERIFIED'
  $protection=GhJson 'repos/kmjtechno/kmj-codebridge/branches/main/protection'
  Need ($protection.enforce_admins.enabled -eq $true -and
    $protection.required_status_checks.strict -eq $true -and
    [int]$protection.required_pull_request_reviews.required_approving_review_count -ge 1
  ) 'AUTOSIGN_BRANCH_PROTECTION_UNVERIFIED'
  $main=GhJson 'repos/kmjtechno/kmj-codebridge/git/ref/heads/main'
  $head=[string]$main.object.sha
  Need ($head -match '^[a-f0-9]{40}$') 'AUTOSIGN_MAIN_SHA_UNVERIFIED'
  $checks=GhJson ('repos/kmjtechno/kmj-codebridge/commits/'+$head+'/check-runs?per_page=100')
  $seen=@($checks.check_runs)
  Need ($seen.Count -ge $ExpectedChecks.Count -and
    $seen.Count -le 100 -and
    [int]$checks.total_count -eq $seen.Count) 'AUTOSIGN_MAIN_CHECKS_INCOMPLETE'
  foreach($check in $seen) {
    Need ([string]$check.head_sha -ceq $head -and
      [string]$check.status -ceq 'completed' -and
      [string]$check.conclusion -ceq 'success' -and
      [string]$check.app.slug -ceq 'github-actions') 'AUTOSIGN_EXACT_HEAD_CI_NOT_GREEN'
  }
  foreach($name in $ExpectedChecks){
    Need (@($seen|Where-Object{$_.name -ceq $name}).Count -eq 1) 'AUTOSIGN_REQUIRED_CHECK_MISSING'
  }
  $again=GhJson 'repos/kmjtechno/kmj-codebridge/git/ref/heads/main'
  Need ([string]$again.object.sha -ceq $head) 'AUTOSIGN_MAIN_MOVED'
  Mark 'OWNER_AUTOSIGN_ENABLE_PREFLIGHT' 'PASS'
  if(-not $Apply) {
    Mark 'OWNER_AUTOSIGN_ENABLE' 'DRY_RUN_ONLY'
    exit 0
  }
  Enable-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop|Out-Null
  $enabled=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  Need ([string]$enabled.State -ceq 'Ready' -and
    @($enabled.Actions).Count -eq 1 -and
    [string]$enabled.Actions[0].Arguments -ceq ('"'+$Signer+'" --once')
  ) 'AUTOSIGN_TASK_ENABLED_READBACK_UNVERIFIED'
  Mark 'OWNER_AUTOSIGN_ENABLE' 'PASS'
  Mark 'OWNER_AUTOSIGN_TASK' 'ENABLED_HOURLY'
  Mark 'OWNER_AUTOSIGN_FIRST_SIGNED_RELEASE' 'NOT_YET_VERIFIED'
} catch {
  $reason=[string]$_.Exception.Message
  if($reason -cnotmatch '^[A-Z][A-Z0-9_]{3,90}$'){$reason='AUTOSIGN_OWNER_REVIEW_REQUIRED'}
  Mark 'OWNER_AUTOSIGN_ENABLE' ('BLOCKED:'+$reason)
  Mark 'OWNER_AUTOSIGN_FIRST_SIGNED_RELEASE' 'NOT_VERIFIED'
  exit 2
}
