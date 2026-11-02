# KMJ P520 protected Supervisor installation discovery — read-only.
# No task creation, file writes, service restarts, downloads or execution of
# unknown programs. Never prints private configuration paths or credentials.
[CmdletBinding()]
param([switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$expectedDevice='kmj-kmj-codebridge-desktop-5fvjmet'
$taskName='KMJ-CodeBridge-Supervisor-P520'
function Mark([string]$key,[string]$value) { Write-Output ($key+'='+$value) }
function Candidate-Identity($cfg) {
  if($null -eq $cfg -or [string]$cfg.id -cne $expectedDevice -or
    @($cfg.projects | Where-Object { $null -ne $_ -and [string]$_.id -ceq 'kmj-codebridge' }).Count -ne 1) {
    return 'UNRELATED'
  }
  $names=@($cfg.PSObject.Properties.Name)
  if($names -contains 'supervisorSocket' -or $names -contains 'supervisorPipe' -or
     $names -contains 'supervisorTokenFile') { return 'ALREADY_CONFIGURED' }
  if([string]$cfg.gateway -notmatch '^https://kmjtechno\.com(?:/|$)') { return 'UNTRUSTED_GATEWAY' }
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
  $good=[pscustomobject]@{id=$expectedDevice;projects=@([pscustomobject]@{id='kmj-codebridge'});gateway='https://kmjtechno.com/mcp'}
  $other=[pscustomobject]@{id='kmj-kmj-omnidesk-desktop-5fvjmet';projects=@([pscustomobject]@{id='kmj-omnidesk'});gateway='https://kmjtechno.com/mcp'}
  $configured=[pscustomobject]@{id=$expectedDevice;projects=@([pscustomobject]@{id='kmj-codebridge'});gateway='https://kmjtechno.com/mcp';supervisorPipe='something'}
  $collision=[pscustomobject]@{TaskName=$taskName;TaskPath='\Other\'}
  if((Candidate-Identity $good) -cne 'MATCH' -or
     (Candidate-Identity $other) -cne 'UNRELATED' -or
     (Candidate-Identity $configured) -cne 'ALREADY_CONFIGURED' -or
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
    if(($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $unsafe=$true;break }
    $seen=0
    foreach($entry in @(Get-ChildItem -LiteralPath $root -Recurse -Depth 3 -Filter 'agent.json' -File -ErrorAction Stop)) {
      $seen++;$searched++
      if($seen -gt 96 -or $searched -gt 160) { $unsafe=$true;break }
      if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $unsafe=$true;break }
      if(-not (Safe-Candidate-Path $root ([string]$entry.FullName))) { $unsafe=$true;break }
      if($entry.Length -lt 20 -or $entry.Length -gt 524288) { continue }
      # Parse locally but never send raw agent.json or its secrets anywhere.
      try {
        $cfg=Get-Content -LiteralPath $entry.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if((Candidate-Identity $cfg) -ceq 'MATCH') { [void]$matches.Add([string]$entry.FullName) }
      } catch {}
    }
    if($unsafe) { break }
  }
  if($unsafe) { $candidate='UNSAFE_OR_UNBOUNDED' }
  elseif($matches.Count -eq 0) { $candidate='NO_EXACT_MATCH' }
  elseif($matches.Count -eq 1) { $candidate='ONE_UNATTESTED_CANDIDATE' }
  else { $candidate='MULTIPLE_AMBIGUOUS' }
  Mark 'P520_INSTALL_AGENT_CONFIG' $candidate

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
