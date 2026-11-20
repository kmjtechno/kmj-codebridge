# KMJ P520 one-click activation of an ALREADY PREPARED, DISABLED native Supervisor.
# Source-only until independently reviewed. No agent config edit, no agent restart.
# -Apply is invoked only by the owner-facing .cmd; default is read-only.
[CmdletBinding()]
param([switch]$Apply,[switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'KMJ-CodeBridge-Supervisor-P520'
$ExpectedDevice = 'kmj-kmj-codebridge-desktop-5fvjmet'
$PinnedSha = 'b652b29beafb9b14e42b0078bfb9571fef5b3271'
$ExpectedOrigin = 'https://github.com/kmjtechno/kmj-codebridge.git'
$Root = Join-Path $env:ProgramData 'KMJ-CodeBridge\P520'
$Release = Join-Path $Root ('releases\' + $PinnedSha)
$SupervisorConfig = Join-Path $Root 'supervisor.json'
$TokenFile = Join-Path $Root 'supervisor.token'
$BackupRoot = Join-Path $Root 'backups'
$Verifier = Join-Path $PSScriptRoot 'P520-ONE-CLICK-PERSISTENT-HMAC-VERIFY-20261117.mjs'
$enabledByUs = $false
function Mark([string]$name,[string]$value) { Write-Output ($name + '=' + $value) }
function Require([bool]$good,[string]$code) { if(-not $good) { throw $code } }
function Normal([string]$path) { return [IO.Path]::GetFullPath($path).TrimEnd('\') }
function Same([string]$a,[string]$b) {
  return [string]::Equals((Normal $a),(Normal $b),[StringComparison]::OrdinalIgnoreCase)
}
function SafeFile([string]$path) {
  if(-not(Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  return (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function SafeDir([string]$path) {
  if(-not(Test-Path -LiteralPath $path -PathType Container)) { return $false }
  return (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function HashFile([string]$path) {
  Require (SafeFile $path) 'FILE_MISSING_OR_LINKED'
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
}
function TaskState([object[]]$tasks) {
  $matched=@($tasks|Where-Object { $null -ne $_ -and [string]$_.TaskName -ieq $TaskName })
  if($matched.Count -ne 1) { return 'TASK_ABSENT_OR_COLLISION' }
  if([string]$matched[0].TaskPath -cne '\') { return 'TASK_WRONG_NAMESPACE' }
  if([string]$matched[0].State -cne 'Disabled') { return 'TASK_NOT_DISABLED' }
  return 'DISABLED'
}
function ScopedAgent([string]$configPath,[bool]$allowSupervisor=$false) {
  $nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
  Require ($nodes.Count -le 64) 'PROCESS_INVENTORY_UNBOUNDED'
  $agents=@($nodes|Where-Object {
    $line=[string]$_.CommandLine
    $line -match 'src[\\/]cli\.js["'']?\s+agent\s+' -and
    $line.IndexOf($configPath,[StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  Require ($agents.Count -eq 1) 'LIVE_AGENT_NOT_UNIQUE'
  $supervisors=@($nodes|Where-Object {
    $line=[string]$_.CommandLine
    $line -match 'src[\\/]cli\.js["'']?\s+windows-supervisor\s+' -and
    $line.IndexOf($SupervisorConfig,[StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if($allowSupervisor) {
    Require ($supervisors.Count -eq 1) 'PERSISTENT_SUPERVISOR_NOT_UNIQUE'
  } else {
    Require ($supervisors.Count -eq 0) 'PREEXISTING_SUPERVISOR_PROCESS'
  }
  return $agents[0]
}
function PrivateToken([string]$principalSid) {
  $acl=Get-Acl -LiteralPath $TokenFile -ErrorAction Stop
  Require $acl.AreAccessRulesProtected 'TOKEN_ACL_INHERITED'
  $allowed=@('S-1-5-18','S-1-5-32-544',$principalSid)
  $observed=@()
  foreach($ace in @($acl.Access)) {
    $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    Require ($sid -in $allowed -and [string]$ace.AccessControlType -ceq 'Allow') 'TOKEN_ACL_UNSAFE'
    $observed+=,$sid
  }
  foreach($sid in $allowed) {
    Require ($sid -in $observed) 'TOKEN_ACL_INCOMPLETE'
  }
}
if($SelfTest) {
  $good=[pscustomobject]@{TaskName=$TaskName;TaskPath='\';State='Disabled'}
  $enabled=[pscustomobject]@{TaskName=$TaskName;TaskPath='\';State='Running'}
  $other=[pscustomobject]@{TaskName=$TaskName;TaskPath='\Other\';State='Disabled'}
  Require ((TaskState -tasks @($good)) -ceq 'DISABLED') 'SELFTEST_GOOD_FAILED'
  Require ((TaskState -tasks @($enabled)) -ceq 'TASK_NOT_DISABLED') 'SELFTEST_ENABLED_FAILED'
  Require ((TaskState -tasks @($good,$other)) -ceq 'TASK_ABSENT_OR_COLLISION') 'SELFTEST_COLLISION_FAILED'
  Require ((TaskState -tasks @()) -ceq 'TASK_ABSENT_OR_COLLISION') 'SELFTEST_ABSENT_FAILED'
  Mark 'P520_ONE_CLICK_SELFTEST' 'PASS'
  exit 0
}
try {
  Require ($env:OS -ceq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'DESKTOP-5FVJMET' -and [Environment]::Is64BitOperatingSystem) 'WRONG_DEVICE'
  $machine=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  Require ($machine.Manufacturer -match '(?i)lenovo' -and [string]$machine.Model -ceq '30BFS1JG13') 'WRONG_HARDWARE'
  foreach($folder in @($Root,(Join-Path $Root 'releases'),$Release,$BackupRoot)) {
    Require (SafeDir $folder) 'STAGE_DIR_MISSING_OR_LINKED'
  }
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  $git=(Get-Command git.exe -ErrorAction Stop).Source
  $major=([string](& $node --version)).TrimStart('v').Split('.')[0]
  Require ($LASTEXITCODE -eq 0 -and [int]$major -ge 24) 'NODE24_REQUIRED'
  $sha=([string](& $git -C $Release rev-parse HEAD)).Trim()
  Require ($LASTEXITCODE -eq 0 -and $sha -ceq $PinnedSha) 'RELEASE_SHA_MISMATCH'
  $origin=([string](& $git -C $Release remote get-url origin)).Trim()
  Require ($LASTEXITCODE -eq 0 -and $origin -ceq $ExpectedOrigin) 'RELEASE_ORIGIN_MISMATCH'
  $dirty=@(& $git -C $Release status --porcelain=v1 --untracked-files=all)
  Require ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'RELEASE_NOT_CLEAN'
  foreach($file in @($SupervisorConfig,$TokenFile,$Verifier,(Join-Path $Release 'src\cli.js'),(Join-Path $Release 'src\supervisor-client.js'))) {
    Require (SafeFile $file) 'REQUIRED_FILE_MISSING_OR_LINKED'
  }
  # The HMAC verifier is security-critical: an edited probe returning exit 0
  # must never authorize a persistent Windows task.
  $verifierBlob=([string](& $git hash-object -- $Verifier)).Trim()
  Require ($LASTEXITCODE -eq 0 -and
           $verifierBlob -ceq 'fe58effe8c0c0129922492dfa2c40dddd144ed46') 'HMAC_PROBE_SOURCE_MISMATCH'
  $cfg=Get-Content -LiteralPath $SupervisorConfig -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
  Require ([string]$cfg.pipeName -ceq 'kmj-codebridge-supervisor-p520' -and
           (Same ([string]$cfg.tokenFile) $TokenFile) -and
           (Same ([string]$cfg.agent.installDir) $Release) -and
           @($cfg.projects).Count -eq 0 -and @($cfg.readOnlyProjects).Count -eq 0 -and
           @($cfg.agent.PSObject.Properties.Name) -notcontains 'restartTask') 'SUPERVISOR_SCOPE_INVALID'
  $agentConfig=[string]$cfg.agent.configPath
  Require (SafeFile $agentConfig) 'AGENT_CONFIG_MISSING_OR_LINKED'
  Require (SafeFile ($agentConfig+'.proposed')) 'AGENT_PROPOSAL_MISSING_OR_LINKED'
  $agent=Get-Content -LiteralPath $agentConfig -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
  $proposal=Get-Content -LiteralPath ($agentConfig+'.proposed') -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
  Require ([string]$agent.id -ceq $ExpectedDevice -and
           @($agent.PSObject.Properties.Name|Where-Object { $_ -in @('supervisorSocket','supervisorPipe','supervisorTokenFile') }).Count -eq 0 -and
           [string]$proposal.supervisorPipe -ceq '\\.\pipe\kmj-codebridge-supervisor-p520' -and
           (Same ([string]$proposal.supervisorTokenFile) $TokenFile)) 'AGENT_PROPOSAL_INVALID'
  $proposal.PSObject.Properties.Remove('supervisorPipe')
  $proposal.PSObject.Properties.Remove('supervisorTokenFile')
  Require ((ConvertTo-Json -InputObject $agent -Depth 64 -Compress) -ceq
           (ConvertTo-Json -InputObject $proposal -Depth 64 -Compress)) 'PROPOSED_DELTA_UNSAFE'
  $directories=@(Get-ChildItem -LiteralPath $BackupRoot -Directory -Force -ErrorAction Stop)
  Require ($directories.Count -le 32) 'BACKUP_DIRECTORY_UNBOUNDED'
  $matches=@()
  foreach($dir in $directories) {
    Require (SafeDir $dir.FullName) 'BACKUP_DIR_LINKED'
    $manifestPath=Join-Path $dir.FullName 'manifest.json'
    if(-not(SafeFile $manifestPath)) { continue }
    $m=Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
    if([int]$m.schema -eq 2 -and [string]$m.taskName -ceq $TaskName) { $matches+=,$m }
  }
  Require ($matches.Count -eq 1) 'BACKUP_MANIFEST_NOT_UNIQUE'
  $manifest=$matches[0]
  Require ($manifest.tokenCreatedByInstaller -eq $true -and
           (Same ([string]$manifest.tokenFile) $TokenFile) -and
           (HashFile $TokenFile) -ceq [string]$manifest.tokenSha256 -and
           (HashFile ($agentConfig+'.proposed')) -ceq [string]$manifest.proposedSha256) 'TOKEN_OR_PROPOSAL_HASH_INVALID'
  $entries=@($manifest.files)
  Require ($entries.Count -eq 2) 'BACKUP_ENTRY_COUNT_INVALID'
  foreach($entry in $entries) {
    Require ((HashFile ([string]$entry.backup)) -ceq [string]$entry.sha256) 'BACKUP_HASH_INVALID'
  }
  $agentEntries=@($entries|Where-Object { Same ([string]$_.source) $agentConfig })
  $supervisorEntries=@($entries|Where-Object { Same ([string]$_.source) $SupervisorConfig })
  Require ($agentEntries.Count -eq 1 -and $supervisorEntries.Count -eq 1) 'BACKUP_SOURCE_INVALID'
  Require ((HashFile $agentConfig) -ceq [string]$agentEntries[0].sha256 -and
           (HashFile $SupervisorConfig) -ceq [string]$supervisorEntries[0].sha256) 'LIVE_CONFIG_CHANGED'
  $tasks=@(Get-ScheduledTask -ErrorAction Stop)
  Require ((TaskState -tasks $tasks) -ceq 'DISABLED') 'TASK_NOT_EXACT_DISABLED'
  $task=@($tasks|Where-Object { [string]$_.TaskName -ieq $TaskName })[0]
  $actions=@($task.Actions)
  $expectedArgs='"'+(Join-Path $Release 'src\cli.js')+'" windows-supervisor "'+$SupervisorConfig+'"'
  Require ($actions.Count -eq 1 -and
           (Same ([string]$actions[0].Execute) $node) -and
           (Same ([string]$actions[0].Execute) ([string]$manifest.taskExe)) -and
           [string]$actions[0].Arguments -ceq $expectedArgs -and
           [string]$actions[0].Arguments -ceq [string]$manifest.taskArgs -and
           (Same ([string]$actions[0].WorkingDirectory) $Release) -and
           @($task.Triggers).Count -ge 1 -and
           [string]$task.Principal.LogonType -ceq 'S4U' -and
           [string]$task.Principal.RunLevel -ceq 'Limited') 'TASK_IDENTITY_INVALID'
  $taskSid=([Security.Principal.NTAccount]::new([string]$task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
  PrivateToken $taskSid
  $activeAgent=ScopedAgent $agentConfig
  $owner=Invoke-CimMethod -InputObject $activeAgent -MethodName GetOwnerSid -ErrorAction Stop
  Require ([string]$owner.Sid -ceq $taskSid) 'AGENT_TASK_OWNER_MISMATCH'
  Mark 'P520_ONE_CLICK_PREFLIGHT' 'PASS'
  Mark 'P520_ONE_CLICK_TASK' 'DISABLED'
  Mark 'P520_ONE_CLICK_EXISTING_AGENT' 'UNTOUCHED'
  if(-not $Apply) {
    Mark 'P520_ONE_CLICK' 'DRY_RUN_PASS'
    exit 0
  }
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $admin=New-Object Security.Principal.WindowsPrincipal($identity)
  Require $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) 'ADMINISTRATOR_REQUIRED'
  Require ([string]$identity.User.Value -ceq $taskSid) 'OPERATOR_PRINCIPAL_MISMATCH'
  # Final race guard. A different task, agent, config or persistent listener blocks.
  Require ((TaskState -tasks @(Get-ScheduledTask -ErrorAction Stop)) -ceq 'DISABLED') 'TASK_RACE'
  $still=ScopedAgent $agentConfig
  Require ([int]$still.ProcessId -eq [int]$activeAgent.ProcessId) 'AGENT_PROCESS_RACE'
  Require ((HashFile $agentConfig) -ceq [string]$agentEntries[0].sha256) 'AGENT_CONFIG_RACE'
  $enabledByUs=$true
  Enable-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop|Out-Null
  Start-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop|Out-Null
  $healthy=$false
  for($attempt=0;$attempt -lt 15;$attempt++) {
    & $node $Verifier $Release $SupervisorConfig 2>$null|Out-Null
    if($LASTEXITCODE -eq 0) { $healthy=$true;break }
    Start-Sleep -Seconds 1
  }
  Require $healthy 'PERSISTENT_HMAC_NOT_READY'
  $now=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  Require ([string]$now.State -ceq 'Running') 'TASK_NOT_RUNNING'
  $after=ScopedAgent $agentConfig $true
  Require ([int]$after.ProcessId -eq [int]$activeAgent.ProcessId) 'AGENT_CHANGED_DURING_ACTIVATION'
  Mark 'P520_ONE_CLICK_HMAC' 'PASS'
  Mark 'P520_ONE_CLICK_TASK' 'RUNNING'
  Mark 'P520_ONE_CLICK_EXISTING_AGENT' 'UNTOUCHED'
  Mark 'P520_ONE_CLICK_AGENT_WIRING' 'PENDING_SEPARATE_GUARDED_HANDOFF'
  Mark 'P520_ONE_CLICK' 'PASS'
} catch {
  $reason=[string]$_.Exception.Message
  if($reason -cnotmatch '^[A-Z][A-Z0-9_]{3,90}$') { $reason='REVIEW_REQUIRED' }
  Mark 'P520_ONE_CLICK_BLOCKER' $reason
  if($enabledByUs) {
    try {
      Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
      Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop|Out-Null
      $state=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
      Require ([string]$state.State -ceq 'Disabled') 'ROLLBACK_NOT_DISABLED'
      Mark 'P520_ONE_CLICK_ROLLBACK' 'PASS'
    } catch {
      Mark 'P520_ONE_CLICK_ROLLBACK' 'FAILED_MANUAL_REVIEW'
    }
  }
  Mark 'P520_ONE_CLICK_EXISTING_AGENT' 'UNTOUCHED_BY_SCRIPT'
  Mark 'P520_ONE_CLICK' 'BLOCKED'
  exit 2
}
