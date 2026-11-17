# P520 post-stage evidence only. No install, credentials readback, task activation or agent modification.
# Prepared task must remain DISABLED; authenticated HMAC activation is a separate owner-approved step.
[CmdletBinding()]
param([switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskName = 'KMJ-CodeBridge-Supervisor-P520'
$pinnedSha = 'b652b29beafb9b14e42b0078bfb9571fef5b3271'
function Mark([string]$key,[string]$value) { Write-Output ($key+'='+$value) }
function Task-Class([object[]]$tasks) {
  $matches = @($tasks | Where-Object { $null -ne $_ -and [string]$_.TaskName -ieq $taskName })
  if($matches.Count -eq 0) { return 'ABSENT' }
  if($matches.Count -ne 1) { return 'COLLISION' }
  $one = $matches[0]
  if([string]$one.TaskPath -cne '\') { return 'WRONG_NAMESPACE' }
  if([string]$one.State -cne 'Disabled') { return 'NOT_DISABLED' }
  return 'DISABLED'
}
function Regular-File([string]$path) {
  if(-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  return $true
}
function Private-Acl([string]$path,[string]$serviceSid) {
  $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
  if(-not $acl.AreAccessRulesProtected) { return $false }
  $allowed=@('S-1-5-18','S-1-5-32-544',$serviceSid)
  $observed=New-Object 'System.Collections.Generic.HashSet[string]'
  foreach($ace in @($acl.Access)) {
    $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if($sid -notin $allowed -or
       $ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
      return $false
    }
    [void]$observed.Add($sid)
  }
  foreach($sid in $allowed) { if(-not $observed.Contains($sid)) { return $false } }
  return $true
}
if($SelfTest) {
  $good=[pscustomobject]@{TaskName=$taskName;TaskPath='\';State='Disabled'}
  $enabled=[pscustomobject]@{TaskName=$taskName;TaskPath='\';State='Ready'}
  $other=[pscustomobject]@{TaskName=$taskName;TaskPath='\Other\';State='Disabled'}
  if((Task-Class -tasks @()) -cne 'ABSENT' -or
     (Task-Class -tasks @($good)) -cne 'DISABLED' -or
     (Task-Class -tasks @($enabled)) -cne 'NOT_DISABLED' -or
     (Task-Class -tasks @($other)) -cne 'WRONG_NAMESPACE' -or
     (Task-Class -tasks @($good,$other)) -cne 'COLLISION') {
    throw 'P520_WITNESS_SELFTEST_FAILED'
  }
  Mark 'P520_WITNESS_SELFTEST' 'PASS'
  exit 0
}
try {
  if($env:OS -cne 'Windows_NT' -or $env:COMPUTERNAME -ine 'DESKTOP-5FVJMET' -or
     -not [Environment]::Is64BitOperatingSystem) { throw 'WRONG_DEVICE' }
  $computer=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  if($computer.Manufacturer -notmatch '(?i)lenovo' -or
     [string]$computer.Model -cne '30BFS1JG13') { throw 'WRONG_HARDWARE' }
  Mark 'P520_WITNESS_DEVICE' 'PASS'
  $tasks=@(Get-ScheduledTask -ErrorAction Stop)
  $taskState=Task-Class -tasks $tasks
  Mark 'P520_WITNESS_TASK' $taskState
  if($taskState -cne 'DISABLED') { throw 'TASK_NOT_DISABLING_PROVEN' }
  $task=@($tasks | Where-Object { [string]$_.TaskName -ieq $taskName })[0]
  $protected=Join-Path $env:ProgramData 'KMJ-CodeBridge\P520'
  $release=Join-Path $protected ('releases\'+$pinnedSha)
  $config=Join-Path $protected 'supervisor.json'
  $token=Join-Path $protected 'supervisor.token'
  $cli=Join-Path $release 'src\cli.js'
  foreach($dir in @($protected,(Join-Path $protected 'releases'),$release)) {
    if(-not (Test-Path -LiteralPath $dir -PathType Container)) { throw 'PINNED_STAGE_MISSING' }
    $item=Get-Item -LiteralPath $dir -Force -ErrorAction Stop
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'STAGE_REPARSE_UNSAFE'
    }
  }
  foreach($file in @($config,$token,$cli)) {
    if(-not (Regular-File $file)) { throw 'EXPECTED_FILE_MISSING_OR_LINKED' }
  }
  $cfg=Get-Content -LiteralPath $config -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  $props=@($cfg.PSObject.Properties.Name)
  if($props -notcontains 'pipeName' -or $props -notcontains 'tokenFile' -or
     $props -notcontains 'agent') { throw 'CONFIG_FIELDS_MISSING' }
  if([string]$cfg.pipeName -cne 'kmj-codebridge-supervisor-p520' -or
     [string]$cfg.tokenFile -cne $token -or
     [string]$cfg.agent.installDir -cne $release) { throw 'CONFIG_BINDING_MISMATCH' }
  $agentPath=[string]$cfg.agent.configPath
  if(-not [IO.Path]::IsPathRooted($agentPath) -or
     -not(Regular-File $agentPath) -or
     -not(Regular-File ($agentPath+'.proposed'))) { throw 'AGENT_PROPOSAL_MISSING' }
  $activeAgent=Get-Content -LiteralPath $agentPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  $proposal=Get-Content -LiteralPath ($agentPath+'.proposed') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  if([string]$activeAgent.id -cne 'kmj-kmj-codebridge-desktop-5fvjmet' -or
     @($activeAgent.PSObject.Properties.Name) -contains 'supervisorPipe' -or
     @($activeAgent.PSObject.Properties.Name) -contains 'supervisorTokenFile') {
    throw 'ACTIVE_AGENT_CHANGED_OR_WRONG'
  }
  if([string]$proposal.supervisorPipe -cne '\\.\pipe\kmj-codebridge-supervisor-p520' -or
     [string]$proposal.supervisorTokenFile -cne $token) { throw 'PROPOSED_BINDING_MISMATCH' }
  $actions=@($task.Actions)
  if($actions.Count -ne 1) { throw 'TASK_ACTION_COUNT_UNSAFE' }
  $action=$actions[0]
  $expectedArgs='"'+$cli+'" windows-supervisor "'+$config+'"'
  if([string]$action.Arguments -cne $expectedArgs -or
     [string]$action.WorkingDirectory -cne $release -or
     -not(Regular-File ([string]$action.Execute))) { throw 'TASK_ACTION_MISMATCH' }
  if([string]$task.Principal.LogonType -cne 'S4U' -or
     [string]$task.Principal.RunLevel -cne 'Limited') { throw 'TASK_PRINCIPAL_UNSAFE' }
  $principalSid=([Security.Principal.NTAccount]::new([string]$task.Principal.UserId)).
     Translate([Security.Principal.SecurityIdentifier]).Value
  if(-not(Private-Acl $token $principalSid)) { throw 'TOKEN_ACL_UNSAFE' }
  Mark 'P520_WITNESS_PINNED_RELEASE' 'PASS'
  Mark 'P520_WITNESS_CONFIG_BINDING' 'PASS'
  Mark 'P520_WITNESS_PROPOSAL_ONLY' 'PASS'
  Mark 'P520_WITNESS_TASK_ACTION' 'PASS'
  Mark 'P520_WITNESS_TOKEN_ACL' 'PASS'
  Mark 'P520_WITNESS_HMAC_AUTHENTICATION' 'NOT_TESTED'
  Mark 'P520_WITNESS_ACTIVATION' 'NOT_ATTEMPTED'
  Mark 'P520_WITNESS_AGENT_OMNIDESK' 'UNTOUCHED'
  Mark 'P520_WITNESS_RESULT' 'DISABLED_STAGE_VERIFIED'
} catch {
  $reason=[string]$_.Exception.Message
  if($reason -notmatch '^[A-Z][A-Z0-9_]{3,80}$') { $reason='REVIEW_REQUIRED' }
  Mark 'P520_WITNESS_RESULT' ('BLOCKED_'+$reason)
  Mark 'P520_WITNESS_AGENT_OMNIDESK' 'UNTOUCHED'
  exit 2
}
