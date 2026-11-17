# KMJ P520 isolated interrupted-checkout recovery. No clone or working-tree reset.
# Dry-run by default. -Apply writes new supervisor.json and a DISABLED task only.
# Never prints private config paths, raw process commands or credentials.
[CmdletBinding()]
param([switch]$SelfTest,[switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$expectedDevice='kmj-kmj-codebridge-desktop-5fvjmet'
$taskName='KMJ-CodeBridge-Supervisor-P520'
function Mark([string]$key,[string]$value) { Write-Output ($key+'='+$value) }
function Candidate-Identity($cfg) {
  # StrictMode must not let an unrelated, malformed JSON object abort the
  # read-only inventory. Missing properties are unrelated, never approved.
  if($null -eq $cfg -or $cfg -isnot [pscustomobject]) { return 'UNRELATED' }
  $names=@($cfg.PSObject.Properties.Name)
  if($names -notcontains 'id' -or $names -notcontains 'gateway' -or
     $names -notcontains 'projects') { return 'UNRELATED' }
  if([string]$cfg.id -cne $expectedDevice -or $cfg.projects -isnot [array] -or
     @($cfg.projects).Count -gt 32) { return 'UNRELATED' }
  $projectMatches=@($cfg.projects | Where-Object {
    $null -ne $_ -and $_ -is [pscustomobject] -and
    $null -ne $_.PSObject.Properties['id'] -and
    [string]$_.id -ceq 'kmj-codebridge'
  })
  if($projectMatches.Count -ne 1) { return 'UNRELATED' }
  if($names -contains 'supervisorSocket' -or $names -contains 'supervisorPipe' -or
     $names -contains 'supervisorTokenFile') { return 'ALREADY_CONFIGURED' }
  # Agent runtime requires an HTTPS root origin, not /mcp.
  # Exact host and root path only; no credentials, query, or fragment.
  if([string]$cfg.gateway -cnotin @('https://kmjtechno.com','https://kmjtechno.com/')) { return 'UNTRUSTED_GATEWAY' }
  return 'MATCH'
}
function Safe-Candidate-Path([string]$root,[string]$candidate) {
  # File paths inherited from a junction/redirected parent are not trusted.
  try {
    $rootFull=[IO.Path]::GetFullPath($root).TrimEnd('\')
    $fileFull=[IO.Path]::GetFullPath($candidate)
    if(-not $fileFull.StartsWith($rootFull+'\', [StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
    $dir=[IO.Path]::GetDirectoryName($fileFull)
    for($i=0;$i -lt 16;$i++) {
      $item=Get-Item -LiteralPath $dir -Force -ErrorAction Stop
      if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $false
      }
      if($dir -ieq $rootFull) { return $true }
      $parent=[IO.Path]::GetDirectoryName($dir.TrimEnd('\'))
      if([string]::IsNullOrWhiteSpace($parent) -or $parent -ieq $dir) { return $false }
      $dir=$parent
    }
  } catch {}
  return $false
}
function Task-Status([object[]]$tasks) {
  if(@($tasks | Where-Object { $null -ne $_ -and [string]$_.TaskName -ieq $taskName }).Count -gt 0) {
    return 'COLLISION'
  }
  return 'ABSENT'
}
if($SelfTest) {
  $good=[pscustomobject]@{id=$expectedDevice;projects=@([pscustomobject]@{id='kmj-codebridge'});gateway='https://kmjtechno.com/'}
  $withoutSlash=[pscustomobject]@{id=$expectedDevice;projects=@([pscustomobject]@{id='kmj-codebridge'});gateway='https://kmjtechno.com'}
  $other=[pscustomobject]@{id='kmj-kmj-omnidesk-desktop-5fvjmet';projects=@([pscustomobject]@{id='kmj-omnidesk'});gateway='https://kmjtechno.com/'}
  $configured=[pscustomobject]@{id=$expectedDevice;projects=@([pscustomobject]@{id='kmj-codebridge'});gateway='https://kmjtechno.com/';supervisorPipe='something'}
  $wrongGateway=[pscustomobject]@{id=$expectedDevice;projects=@([pscustomobject]@{id='kmj-codebridge'});gateway='https://kmjtechno.com/not-mcp'}
  $missingFields=[pscustomobject]@{id=$expectedDevice}
  $malformedProjects=[pscustomobject]@{id=$expectedDevice;gateway='https://kmjtechno.com/';projects=@('kmj-codebridge')}
  $duplicateProjects=[pscustomobject]@{id=$expectedDevice;gateway='https://kmjtechno.com/';projects=@([pscustomobject]@{id='kmj-codebridge'},[pscustomobject]@{id='kmj-codebridge'})}
  $collision=[pscustomobject]@{TaskName=$taskName;TaskPath='\Other\'}
  if((Candidate-Identity $good) -cne 'MATCH' -or
     (Candidate-Identity $withoutSlash) -cne 'MATCH' -or
     (Candidate-Identity $other) -cne 'UNRELATED' -or
     (Candidate-Identity $configured) -cne 'ALREADY_CONFIGURED' -or
     (Candidate-Identity $wrongGateway) -cne 'UNTRUSTED_GATEWAY' -or
     (Candidate-Identity $missingFields) -cne 'UNRELATED' -or
     (Candidate-Identity $malformedProjects) -cne 'UNRELATED' -or
     (Candidate-Identity $duplicateProjects) -cne 'UNRELATED' -or
     (Task-Status -tasks @()) -cne 'ABSENT' -or
     (Task-Status -tasks @($collision)) -cne 'COLLISION') {
    throw 'P520_INSTALL_PREFLIGHT_SELFTEST_FAILED'
  }
  Mark 'P520_INSTALL_PREFLIGHT_SELFTEST' 'PASS'
  exit 0
}
try {
  if($env:OS -cne 'Windows_NT' -or $env:COMPUTERNAME -ine 'DESKTOP-5FVJMET' -or
     -not [Environment]::Is64BitOperatingSystem) { throw 'WRONG_DEVICE' }
  $pc=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  if($pc.Manufacturer -notmatch '(?i)lenovo' -or [string]$pc.Model -cne '30BFS1JG13') {
    throw 'WRONG_HARDWARE'
  }
  Mark 'P520_INSTALL_DEVICE' 'PASS'
  $allTasks=@(Get-ScheduledTask -ErrorAction Stop)
  Mark 'P520_INSTALL_SUPERVISOR_TASK' (Task-Status -tasks $allTasks)

  # Known possible P520 private roots only, never the P720 agent installation.
  # Missing roots are skipped, never created.
  $roots=@(
    (Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\private'),
    (Join-Path $env:USERPROFILE 'KMJ\codebridge-runtime\private'),
    (Join-Path $env:USERPROFILE 'KMJ\private'),
    'D:\KMJ-HyperSpeed\private',
    'E:\KMJ\private',
    'E:\KMJ\CodeBridge-HomeOffice\private'
  )
  $matches=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $searched=0
  $unsafe=$false
  foreach($root in $roots) {
    if(-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    $rootInfo=Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if(($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $unsafe=$true
      break
    }
    # Bounded BFS: NEVER materialize unbounded recursive Get-ChildItem output.
    $pending=New-Object 'System.Collections.Queue'
    $pending.Enqueue(@($root,0))
    while($pending.Count -gt 0 -and -not $unsafe) {
      $node=$pending.Dequeue()
      $folder=[string]$node[0]
      $depth=[int]$node[1]
      # Cap the enumerated filesystem entries BEFORE materializing the array.
      # Select-Object stops upstream traversal after the remaining budget + 1.
      $limit = 161 - $searched
      if($limit -le 0) { $unsafe=$true;break }
      foreach($entry in @(Get-ChildItem -LiteralPath $folder -Force -ErrorAction Stop |
                        Select-Object -First $limit)) {
        $searched++
        if($searched -gt 160) { $unsafe=$true;break }
        if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          $unsafe=$true
          break
        }
        if($entry.PSIsContainer) {
          if($depth -lt 3) { $pending.Enqueue(@([string]$entry.FullName,($depth+1))) }
          continue
        }
        if($entry.Name -ine 'agent.json') { continue }
        if($entry.Length -lt 20 -or $entry.Length -gt 524288) { continue }
        if(-not (Safe-Candidate-Path $root ([string]$entry.FullName))) {
          $unsafe=$true
          break
        }
        # Parse locally but never print the sensitive JSON or file path.
        try {
          $cfg=Get-Content -LiteralPath $entry.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
          if((Candidate-Identity $cfg) -ceq 'MATCH') {
            [void]$matches.Add([string]$entry.FullName)
          }
        } catch {}
      }
    }
    if($unsafe) { break }
  }
  if($unsafe) { $candidate='UNSAFE_OR_UNBOUNDED' }
  elseif($matches.Count -eq 0) { $candidate='NO_EXACT_MATCH' }
  elseif($matches.Count -eq 1) { $candidate='ONE_UNATTESTED_CANDIDATE' }
  else { $candidate='MULTIPLE_AMBIGUOUS' }
  Mark 'P520_INSTALL_AGENT_CONFIG' $candidate
  # Correlate the single discovered config with running node agent argv.
  # Process command lines may contain secrets: never output them, paths, PIDs,
  # principal names, or candidate bytes. This is an observation, NOT proof
  # of signed runtime provenance or HMAC Supervisor identity.
  $liveBinding='NO_EXACT_CANDIDATE'
  if($candidate -eq 'ONE_UNATTESTED_CANDIDATE') {
    $liveBinding='PROCESS_QUERY_UNVERIFIED'
    try {
      $only=@($matches | Select-Object -First 1)[0]
      $nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
      if($nodes.Count -gt 64) { $liveBinding='PROCESS_INVENTORY_UNBOUNDED' }
      else {
        $hits=0
        foreach($proc in $nodes) {
          if($null -eq $proc -or [string]::IsNullOrEmpty([string]$proc.CommandLine)) { continue }
          $line=[string]$proc.CommandLine
          # Do not consider arbitrary CLI processes to be the enrolled agent.
          if($line -notmatch '(?i)src[\\/]cli\.js["'']?\s+agent\s+') { continue }
          if($line.IndexOf([string]$only,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $hits++ }
        }
        if($hits -eq 1) { $liveBinding='ONE_PROCESS_REFERENCES_CANDIDATE_UNATTESTED' }
        elseif($hits -gt 1) { $liveBinding='MULTIPLE_PROCESSES_REFER_CANDIDATE' }
        else { $liveBinding='NO_MATCHING_PROCESS_OBSERVED' }
      }
    } catch { $liveBinding='PROCESS_QUERY_UNVERIFIED' }
  }
  Mark 'P520_INSTALL_LIVE_CONFIG_OBSERVATION' $liveBinding
  # All source continuity checks are hard gates. Never retry a failed clone.
  if((Task-Status -tasks $allTasks) -cne 'ABSENT' -or
     $candidate -cne 'ONE_UNATTESTED_CANDIDATE' -or
     $liveBinding -cne 'ONE_PROCESS_REFERENCES_CANDIDATE_UNATTESTED') {
    throw 'P520_RESUME_IDENTITY_UNVERIFIED'
  }
  $me=[Security.Principal.WindowsIdentity]::GetCurrent()
  $admin=New-Object Security.Principal.WindowsPrincipal($me)
  if(-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'ADMINISTRATOR_REQUIRED'
  }
  $actualProcess=@($nodes | Where-Object {
    $line=[string]$_.CommandLine
    $line -match '(?i)src[\\/]cli\.js["'']?\s+agent\s+' -and
    $line.IndexOf([string]$only,[StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if($actualProcess.Count -ne 1) { throw 'P520_LIVE_PROCESS_AMBIGUOUS' }
  $owner=Invoke-CimMethod -InputObject $actualProcess[0] -MethodName GetOwnerSid -ErrorAction Stop
  if([string]$owner.Sid -cne $me.User.Value) { throw 'P520_LIVE_OWNER_MISMATCH' }
  $processNode=[string]$actualProcess[0].ExecutablePath
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  if([string]::IsNullOrWhiteSpace($processNode) -or
     -not [string]::Equals($node,$processNode,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'P520_NODE_RUNTIME_MISMATCH'
  }
  foreach($file in @($node,$only)) {
    if(-not(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'P520_REQUIRED_FILE_MISSING' }
    $item=Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'P520_UNTRUSTED_REPARSE_FILE'
    }
  }
  $major=([string](& $node --version)).TrimStart('v').Split('.')[0]
  if($LASTEXITCODE -ne 0 -or [int]$major -lt 24) { throw 'NODE_24_REQUIRED' }
  $git=(Get-Command git.exe -ErrorAction Stop).Source
  $serviceAccount=$me.Name
  if($serviceAccount.Length -gt 64 -or
     $serviceAccount -notmatch '^[A-Za-z0-9_.\\-]+(?: [A-Za-z0-9_.\\-]+)*$') {
    throw 'SERVICE_ACCOUNT_UNSUPPORTED'
  }
  $pinnedSha='b652b29beafb9b14e42b0078bfb9571fef5b3271'
  $expectedOrigin='https://github.com/kmjtechno/kmj-codebridge.git'
  $protected=Join-Path $env:ProgramData 'KMJ-CodeBridge\P520'
  $parent=Join-Path $env:ProgramData 'KMJ-CodeBridge'
  $release=Join-Path $protected ('releases\'+$pinnedSha)
  $backup=Join-Path $protected 'backups'
  $config=Join-Path $protected 'supervisor.json'
  $token=Join-Path $protected 'supervisor.token'
  $cli=Join-Path $release 'src\cli.js'
  $installer=Join-Path $release 'scripts\windows\install-windows-supervisor.ps1'
  foreach($dir in @($parent,$protected,(Join-Path $protected 'releases'),$release,(Join-Path $release '.git'),$backup)) {
    if(-not(Test-Path -LiteralPath $dir -PathType Container)) { throw 'P520_STAGE_INCOMPLETE' }
    $item=Get-Item -LiteralPath $dir -Force -ErrorAction Stop
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'P520_STAGE_REPARSE_UNSAFE'
    }
  }
  foreach($file in @($cli,$installer,(Join-Path $release 'package-lock.json'))) {
    if(-not(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'P520_PINNED_FILE_MISSING' }
    $item=Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'P520_PINNED_FILE_REPARSE'
    }
  }
  $stageAcl=Get-Acl -LiteralPath $protected -ErrorAction Stop
  if(-not $stageAcl.AreAccessRulesProtected) { throw 'P520_STAGE_ACL_INHERITED' }
  $allowed=@('S-1-5-18','S-1-5-32-544',$me.User.Value)
  foreach($ace in @($stageAcl.Access)) {
    $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if($sid -notin $allowed -or
       $ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
      throw 'P520_STAGE_ACL_UNTRUSTED'
    }
  }
  $actualSha=[string](& $git -C $release rev-parse HEAD)
  $actualOrigin=[string](& $git -C $release remote get-url origin)
  if($LASTEXITCODE -ne 0 -or $actualSha.Trim() -cne $pinnedSha -or
     $actualOrigin.Trim() -cne $expectedOrigin) { throw 'P520_RELEASE_PROVENANCE_MISMATCH' }
  $dirty=@(& $git -C $release status --porcelain=v1 --untracked-files=all)
  if($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) { throw 'P520_RELEASE_NOT_CLEAN' }
  if(-not(Test-Path -LiteralPath (Join-Path $release 'node_modules') -PathType Container)) {
    throw 'P520_DEPENDENCIES_NOT_INSTALLED'
  }
  if(Test-Path -LiteralPath $config) { throw 'P520_SUPERVISOR_CONFIG_ALREADY_EXISTS' }
  if(Test-Path -LiteralPath $token) { throw 'P520_TOKEN_ALREADY_EXISTS' }
  if(Test-Path -LiteralPath ($only+'.proposed')) { throw 'P520_AGENT_PROPOSAL_ALREADY_EXISTS' }
  if(@(Get-ChildItem -LiteralPath $backup -Force -ErrorAction Stop).Count -ne 0) {
    throw 'P520_EXISTING_BACKUP_REVIEW_REQUIRED'
  }
  $installerText=Get-Content -LiteralPath $installer -Raw -ErrorAction Stop
  if(-not $installerText.Contains('Assert-NoSupervisorTaskCollision') -or
     -not $installerText.Contains('Get-ScheduledTask -ErrorAction Stop') -or
     -not $installerText.Contains('Disable-ScheduledTask')) {
    throw 'P520_PINNED_INSTALLER_GUARD_MISSING'
  }
  Mark 'P520_RESUME_PINNED_RELEASE' 'PASS'
  Mark 'P520_RESUME_DEPENDENCIES' 'PASS'
  Mark 'P520_RESUME_LIVE_OWNER' 'PASS'
  Mark 'P520_RESUME_STAGE_ACL' 'PASS'
  Mark 'P520_RESUME_TASK_COLLISION' 'ABSENT'
  Mark 'P520_RESUME_MODE' $(if($Apply){'DISABLED_ONLY'}else{'READ_ONLY'})
  Mark 'P520_RESUME_AGENT' 'UNTOUCHED'
  Mark 'P520_RESUME_OMNIDESK' 'UNTOUCHED'
  if(-not $Apply) {
    Mark 'P520_RESUME_RESULT' 'DRY_RUN_PASS_NO_CHANGES'
    exit 0
  }
  # Double-check the task and proposal immediately before the only mutation.
  if((Task-Status -tasks @(Get-ScheduledTask -ErrorAction Stop)) -cne 'ABSENT') {
    throw 'P520_TASK_COLLISION_RECHECK'
  }
  if(Test-Path -LiteralPath $config -PathType Leaf) { throw 'P520_CONFIG_RACE' }
  if(Test-Path -LiteralPath $token -PathType Leaf) { throw 'P520_TOKEN_RACE' }
  if(Test-Path -LiteralPath ($only+'.proposed')) { throw 'P520_PROPOSED_RACE' }
  # Creates a NEW private config, not an edit to live agent.json.
  $newConfig=[ordered]@{
    pipeName='kmj-codebridge-supervisor-p520'
    tokenFile=$token
    agent=[ordered]@{ installDir=$release; configPath=$only }
    projects=@()
    readOnlyProjects=@()
  }
  [IO.File]::WriteAllText($config,($newConfig | ConvertTo-Json -Depth 8),
    ([Text.UTF8Encoding]::new($false)))
  Mark 'P520_RESUME_CONFIG' 'WRITTEN_NEW'
  $call=@{
    SupervisorConfig=$config
    AgentConfig=$only
    RuntimeDir=$release
    BackupRoot=$backup
    ServiceAccount=$serviceAccount
    TaskName=$taskName
    Apply=$true
  }
  & $installer @call
  if(-not $?) { throw 'P520_PINNED_INSTALLER_FAILED' }
  $prepared=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
  if(@($prepared).Count -ne 1 -or [string]$prepared.State -cne 'Disabled') {
    throw 'P520_TASK_NOT_DISABLED'
  }
  $newTokenAcl=Get-Acl -LiteralPath $token -ErrorAction Stop
  if(-not $newTokenAcl.AreAccessRulesProtected) { throw 'P520_NEW_TOKEN_ACL_UNSAFE' }
  $proposed=$only+'.proposed'
  if(-not(Test-Path -LiteralPath $proposed -PathType Leaf)) {
    throw 'P520_PROPOSED_AGENT_CONFIG_MISSING'
  }
  Mark 'P520_RESUME_TASK' 'DISABLED'
  Mark 'P520_RESUME_RESULT' 'PREPARED_NOT_ACTIVATED'
  Mark 'P520_RESUME_LIVE_AGENT' 'UNTOUCHED'
} catch {
  $reason=[string]$_.Exception.Message
  if($reason -notmatch '^[A-Z][A-Z0-9_]{3,90}$') { $reason='REVIEW_REQUIRED' }
  Mark 'P520_RESUME_RESULT' ('BLOCKED_'+$reason)
  Mark 'P520_RESUME_LIVE_AGENT' 'UNTOUCHED'
  Mark 'P520_RESUME_OMNIDESK' 'UNTOUCHED'
  exit 2
}
