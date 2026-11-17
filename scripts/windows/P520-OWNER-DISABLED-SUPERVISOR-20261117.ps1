# KMJ P520 protected Supervisor; read-only unless explicit -Apply.
# -Apply prepares disabled task only. No agent or OmniDesk restart.
# Never prints private configuration paths or credentials.
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

  if($Apply) {
    if($candidate -cne 'ONE_UNATTESTED_CANDIDATE' -or
       $liveBinding -cne 'ONE_PROCESS_REFERENCES_CANDIDATE_UNATTESTED' -or
       (Task-Status -tasks @(Get-ScheduledTask -ErrorAction Stop)) -cne 'ABSENT') {
      throw 'P520_IDENTITY_COLLISION'
    }
    $self=[Security.Principal.WindowsIdentity]::GetCurrent()
    $admin=New-Object Security.Principal.WindowsPrincipal($self)
    if(-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'ADMINISTRATOR_REQUIRED'
    }
    $live=@($nodes | Where-Object {
      $line=[string]$_.CommandLine
      $line -match '(?i)src[\\/]+cli\.js["'']?\s+agent\s+' -and
      $line.IndexOf($only,[StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if($live.Count -ne 1) { throw 'ACTIVE_AGENT_NOT_UNIQUE' }
    $owner=Invoke-CimMethod -InputObject $live[0] -MethodName GetOwnerSid -ErrorAction Stop
    if([string]$owner.Sid -cne $self.User.Value) { throw 'OWNER_PROCESS_MISMATCH' }
    $node=[string]$live[0].ExecutablePath
    if(-not(Test-Path -LiteralPath $node -PathType Leaf)) { throw 'PINNED_NODE_MISSING' }
    if(((Get-Item -LiteralPath $node -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'PINNED_NODE_REPARSE'
    }
    $version=[string](& $node --version)
    if($LASTEXITCODE -ne 0 -or $version -notmatch '^v(2[4-9]|[3-9][0-9])\.') {
      throw 'NODE_24_REQUIRED'
    }
    $npm=Join-Path (Split-Path -Parent $node) 'npm.cmd'
    if(-not(Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'PINNED_NPM_MISSING' }
    $git=(Get-Command git.exe -ErrorAction Stop).Source
    $principal=$self.Name
    if($principal.Length -gt 64 -or
       $principal -cnotmatch '^[A-Za-z0-9_.\\-]+(?: [A-Za-z0-9_.\\-]+)*
  Mark 'P520_INSTALL_OWNER_SIGNATURE' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_TOKEN_ACL' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_RUNTIME_BINDING' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_TASK_PROVENANCE' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_ACTION' 'NONE'
  Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
  Mark 'P520_INSTALL_PREFLIGHT' 'READ_ONLY_COMPLETE'
} catch {
  $reason=[string]$_.Exception.Message
  if($reason -notmatch '^[A-Z][A-Z0-9_]{3,90}
  Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
  exit 2
}
) {
      throw 'TASK_PRINCIPAL_INVALID'
    }
    $sha='b652b29beafb9b14e42b0078bfb9571fef5b3271'
    $origin='https://github.com/kmjtechno/kmj-codebridge.git'
    $parent=Join-Path $env:ProgramData 'KMJ-CodeBridge'
    $root=Join-Path $parent 'P520'
    if(Test-Path -LiteralPath $root){ throw 'STAGE_ALREADY_EXISTS' }
    if(Test-Path -LiteralPath $parent){
      $existingParent=Get-Item -LiteralPath $parent -Force
      if(($existingParent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
        throw 'STAGE_PARENT_REPARSE'
      }
      $aclParent=Get-Acl -LiteralPath $parent
      if(-not $aclParent.AreAccessRulesProtected){throw 'STAGE_PARENT_UNPROTECTED'}
      foreach($ace in $aclParent.Access){
        $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if($sid -notin @('S-1-5-18','S-1-5-32-544',$self.User.Value)){
          throw 'STAGE_PARENT_UNTRUSTED_ACL'
        }
      }
    } else {
      New-Item -ItemType Directory -Path $parent -ErrorAction Stop | Out-Null
      & icacls.exe $parent /inheritance:r /grant:r 'NT AUTHORITY\SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' ($principal+':(OI)(CI)RX') *> $null
      if($LASTEXITCODE -ne 0){throw 'STAGE_PARENT_ACL_FAILED'}
    }
    New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
    & icacls.exe $root /inheritance:r /grant:r 'NT AUTHORITY\SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' ($principal+':(OI)(CI)RX') *> $null
    if($LASTEXITCODE -ne 0){throw 'STAGE_ROOT_ACL_FAILED'}
    $rootAcl=Get-Acl -LiteralPath $root
    if(-not $rootAcl.AreAccessRulesProtected){throw 'STAGE_ROOT_ACL_UNVERIFIED'}
    foreach($ace in $rootAcl.Access){
      $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if($sid -notin @('S-1-5-18','S-1-5-32-544',$self.User.Value)){
        throw 'STAGE_ROOT_UNTRUSTED_ACL'
      }
    }
    $release=Join-Path $root ('releases\'+$sha)
    $backups=Join-Path $root 'backups'
    New-Item -ItemType Directory -Path (Join-Path $root 'releases') -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $backups -ErrorAction Stop | Out-Null
    Mark 'P520_STAGE_PROTECTED_ROOT' 'PASS'
    & $git -c core.hooksPath=NUL clone --no-checkout --filter=blob:none $origin $release *> $null
    if($LASTEXITCODE -ne 0){throw 'PINNED_CLONE_FAILED'}
    & $git -C $release -c core.hooksPath=NUL checkout --detach $sha *> $null
    if($LASTEXITCODE -ne 0){throw 'PINNED_CHECKOUT_FAILED'}
    $actual=[string](& $git -C $release rev-parse HEAD)
    $remote=[string](& $git -C $release remote get-url origin)
    if($actual.Trim() -cne $sha -or $remote.Trim() -cne $origin){
      throw 'PINNED_RELEASE_PROVENANCE_FAILED'
    }
    $dirty=@(& $git -C $release status --porcelain=v1 --untracked-files=all)
    if($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0){throw 'PINNED_RELEASE_DIRTY'}
    Mark 'P520_STAGE_RELEASE_SHA' $sha
    $env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
    & $npm --prefix $release ci --omit=dev --ignore-scripts --no-audit --no-fund *> $null
    if($LASTEXITCODE -ne 0){throw 'PINNED_DEPENDENCIES_FAILED'}
    $conf=Join-Path $root 'supervisor.json'
    $token=[REDACTED] $root 'supervisor.token'
    $c=[ordered]@{
      pipeName='kmj-codebridge-supervisor-p520'
      tokenFile=$token
      agent=[ordered]@{installDir=$release;configPath=$only}
      projects=@()
      readOnlyProjects=@()
    }
    [IO.File]::WriteAllText($conf,($c | ConvertTo-Json -Depth 8),([Text.UTF8Encoding]::new($false)))
    $installer=Join-Path $release 'scripts\windows\install-windows-supervisor.ps1'
    if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'PINNED_INSTALLER_MISSING'}
    $source=Get-Content -LiteralPath $installer -Raw -ErrorAction Stop
    if(-not $source.Contains('Assert-NoSupervisorTaskCollision') -or
       -not $source.Contains('Get-ScheduledTask -ErrorAction Stop')){
      throw 'PINNED_INSTALLER_GUARD_MISSING'
    }
    $params=@{
      SupervisorConfig=$conf;AgentConfig=$only;RuntimeDir=$release
      BackupRoot=$backups;ServiceAccount=$principal;TaskName=$taskName;Apply=$true
    }
    & $installer @params *> $null
    if(-not $?){throw 'DISABLED_INSTALLER_FAILED'}
    $staged=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
    if(@($staged).Count -ne 1 -or [string]$staged.State -cne 'Disabled'){
      throw 'TASK_NOT_DISABLED'
    }
    Mark 'P520_STAGE_TASK' 'DISABLED'
    Mark 'P520_STAGE_RESULT' 'PREPARED_NOT_ACTIVATED'
    Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
    exit 0
  }
  # A matching config is NOT evidence that this is the live process's config.
  Mark 'P520_INSTALL_OWNER_SIGNATURE' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_TOKEN_ACL' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_RUNTIME_BINDING' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_TASK_PROVENANCE' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_ACTION' 'NONE'
  Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
  Mark 'P520_INSTALL_PREFLIGHT' 'READ_ONLY_COMPLETE'
} catch {
  Mark 'P520_INSTALL_PREFLIGHT' 'BLOCKED_NOT_ATTESTED'
  Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
  exit 2
}
){$reason='REVIEW_REQUIRED'}
  Mark 'P520_STAGE_RESULT' ('BLOCKED_'+$reason)
  Mark 'P520_INSTALL_PREFLIGHT' 'BLOCKED_NOT_ATTESTED'
  Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
  exit 2
}
) {
      throw 'TASK_PRINCIPAL_INVALID'
    }
    $sha='b652b29beafb9b14e42b0078bfb9571fef5b3271'
    $origin='https://github.com/kmjtechno/kmj-codebridge.git'
    $parent=Join-Path $env:ProgramData 'KMJ-CodeBridge'
    $root=Join-Path $parent 'P520'
    if(Test-Path -LiteralPath $root){ throw 'STAGE_ALREADY_EXISTS' }
    if(Test-Path -LiteralPath $parent){
      $existingParent=Get-Item -LiteralPath $parent -Force
      if(($existingParent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
        throw 'STAGE_PARENT_REPARSE'
      }
      $aclParent=Get-Acl -LiteralPath $parent
      if(-not $aclParent.AreAccessRulesProtected){throw 'STAGE_PARENT_UNPROTECTED'}
      foreach($ace in $aclParent.Access){
        $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if($sid -notin @('S-1-5-18','S-1-5-32-544',$self.User.Value)){
          throw 'STAGE_PARENT_UNTRUSTED_ACL'
        }
      }
    } else {
      New-Item -ItemType Directory -Path $parent -ErrorAction Stop | Out-Null
      & icacls.exe $parent /inheritance:r /grant:r 'NT AUTHORITY\SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' ($principal+':(OI)(CI)RX') *> $null
      if($LASTEXITCODE -ne 0){throw 'STAGE_PARENT_ACL_FAILED'}
    }
    New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
    & icacls.exe $root /inheritance:r /grant:r 'NT AUTHORITY\SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' ($principal+':(OI)(CI)RX') *> $null
    if($LASTEXITCODE -ne 0){throw 'STAGE_ROOT_ACL_FAILED'}
    $rootAcl=Get-Acl -LiteralPath $root
    if(-not $rootAcl.AreAccessRulesProtected){throw 'STAGE_ROOT_ACL_UNVERIFIED'}
    foreach($ace in $rootAcl.Access){
      $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if($sid -notin @('S-1-5-18','S-1-5-32-544',$self.User.Value)){
        throw 'STAGE_ROOT_UNTRUSTED_ACL'
      }
    }
    $release=Join-Path $root ('releases\'+$sha)
    $backups=Join-Path $root 'backups'
    New-Item -ItemType Directory -Path (Join-Path $root 'releases') -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $backups -ErrorAction Stop | Out-Null
    Mark 'P520_STAGE_PROTECTED_ROOT' 'PASS'
    & $git -c core.hooksPath=NUL clone --no-checkout --filter=blob:none $origin $release *> $null
    if($LASTEXITCODE -ne 0){throw 'PINNED_CLONE_FAILED'}
    & $git -C $release -c core.hooksPath=NUL checkout --detach $sha *> $null
    if($LASTEXITCODE -ne 0){throw 'PINNED_CHECKOUT_FAILED'}
    $actual=[string](& $git -C $release rev-parse HEAD)
    $remote=[string](& $git -C $release remote get-url origin)
    if($actual.Trim() -cne $sha -or $remote.Trim() -cne $origin){
      throw 'PINNED_RELEASE_PROVENANCE_FAILED'
    }
    $dirty=@(& $git -C $release status --porcelain=v1 --untracked-files=all)
    if($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0){throw 'PINNED_RELEASE_DIRTY'}
    Mark 'P520_STAGE_RELEASE_SHA' $sha
    $env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
    & $npm --prefix $release ci --omit=dev --ignore-scripts --no-audit --no-fund *> $null
    if($LASTEXITCODE -ne 0){throw 'PINNED_DEPENDENCIES_FAILED'}
    $conf=Join-Path $root 'supervisor.json'
    $token=[REDACTED] $root 'supervisor.token'
    $c=[ordered]@{
      pipeName='kmj-codebridge-supervisor-p520'
      tokenFile=$token
      agent=[ordered]@{installDir=$release;configPath=$only}
      projects=@()
      readOnlyProjects=@()
    }
    [IO.File]::WriteAllText($conf,($c | ConvertTo-Json -Depth 8),([Text.UTF8Encoding]::new($false)))
    $installer=Join-Path $release 'scripts\windows\install-windows-supervisor.ps1'
    if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'PINNED_INSTALLER_MISSING'}
    $source=Get-Content -LiteralPath $installer -Raw -ErrorAction Stop
    if(-not $source.Contains('Assert-NoSupervisorTaskCollision') -or
       -not $source.Contains('Get-ScheduledTask -ErrorAction Stop')){
      throw 'PINNED_INSTALLER_GUARD_MISSING'
    }
    $params=@{
      SupervisorConfig=$conf;AgentConfig=$only;RuntimeDir=$release
      BackupRoot=$backups;ServiceAccount=$principal;TaskName=$taskName;Apply=$true
    }
    & $installer @params *> $null
    if(-not $?){throw 'DISABLED_INSTALLER_FAILED'}
    $staged=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
    if(@($staged).Count -ne 1 -or [string]$staged.State -cne 'Disabled'){
      throw 'TASK_NOT_DISABLED'
    }
    Mark 'P520_STAGE_TASK' 'DISABLED'
    Mark 'P520_STAGE_RESULT' 'PREPARED_NOT_ACTIVATED'
    Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
    exit 0
  }
  # A matching config is NOT evidence that this is the live process's config.
  Mark 'P520_INSTALL_OWNER_SIGNATURE' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_TOKEN_ACL' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_RUNTIME_BINDING' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_TASK_PROVENANCE' 'NOT_VERIFIED'
  Mark 'P520_INSTALL_ACTION' 'NONE'
  Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
  Mark 'P520_INSTALL_PREFLIGHT' 'READ_ONLY_COMPLETE'
} catch {
  Mark 'P520_INSTALL_PREFLIGHT' 'BLOCKED_NOT_ATTESTED'
  Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
  exit 2
}
