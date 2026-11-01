# KMJ P520 — read-only Windows Supervisor readiness audit.
# No install/start/stop/task edits, no model or credential changes.
# Emits only bounded status markers, never paths, tokens or account names.
[CmdletBinding()]
param([switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskName = 'KMJ-CodeBridge-Supervisor-P520'

function Mark([string]$key,[string]$value) {
  Write-Output ($key + '=' + $value)
}
function Classify-Task([string]$state) {
  if($state -ceq 'ABSENT') { return 'ABSENT_UNPROVISIONED' }
  if($state -ceq 'Disabled') { return 'DISABLED_UNATTESTED' }
  if($state -in @('Ready','Running','Queued')) { return 'PRESENT_ACTIVE_UNATTESTED' }
  return 'PRESENT_UNKNOWN_UNATTESTED'
}
function Classify-Listener([object[]]$sockets) {
  if($sockets.Count -ne 1) { return 'ABSENT_OR_AMBIGUOUS' }
  if([string]$sockets[0].LocalAddress -cne '127.0.0.1') { return 'NON_LOOPBACK_LISTENER' }
  $value = 0
  if(-not [int]::TryParse([string]$sockets[0].OwningProcess,[ref]$value) -or $value -le 0) {
    return 'INVALID_LISTENER_IDENTITY'
  }
  return 'UNIQUE_LOOPBACK_OBSERVED'
}
function Classify-Node([int]$major) {
  if($major -lt 24) { return 'UNSUPPORTED_VERSION' }
  return 'MINIMUM_VERSION_OBSERVED'
}
# Only a successfully completed inventory can establish task absence.
# A filtered SilentlyContinue lookup can confuse AccessDenied with NotFound.
function Classify-TaskInventory([object[]]$tasks) {
  $matching = @($tasks | Where-Object {
    $null -ne $_ -and
    [string]$_.TaskName -ieq $taskName -and
    [string]$_.TaskPath -ceq '\'
  })
  if($matching.Count -eq 0) { return 'ABSENT_UNPROVISIONED' }
  if($matching.Count -ne 1) { return 'PRESENT_UNKNOWN_UNATTESTED' }
  return Classify-Task ([string]$matching[0].State)
}
if($SelfTest) {
  if((Classify-Task 'ABSENT') -cne 'ABSENT_UNPROVISIONED' -or
     (Classify-Task 'Disabled') -cne 'DISABLED_UNATTESTED' -or
     (Classify-Task 'Running') -cne 'PRESENT_ACTIVE_UNATTESTED' -or
     (Classify-Task 'Unknown') -cne 'PRESENT_UNKNOWN_UNATTESTED') {
    throw 'P520_TASK_SELFTEST_FAILED'
  }
  if((Classify-Node 24) -cne 'MINIMUM_VERSION_OBSERVED' -or
     (Classify-Node 23) -cne 'UNSUPPORTED_VERSION') {
    throw 'P520_NODE_SELFTEST_FAILED'
  }
  $good = [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=123}
  $bad = [pscustomobject]@{LocalAddress='0.0.0.0';OwningProcess=123}
  if((Classify-Listener -sockets @($good)) -cne 'UNIQUE_LOOPBACK_OBSERVED' -or
     (Classify-Listener -sockets @($bad)) -cne 'NON_LOOPBACK_LISTENER' -or
     (Classify-Listener -sockets @($good,$good)) -cne 'ABSENT_OR_AMBIGUOUS' -or
     (Classify-Listener -sockets @()) -cne 'ABSENT_OR_AMBIGUOUS') {
    throw 'P520_LISTENER_SELFTEST_FAILED'
  }
  $present = [pscustomobject]@{TaskName=$taskName;TaskPath='\';State='Ready'}
  $unrelated = [pscustomobject]@{TaskName='Unrelated';TaskPath='\';State='Ready'}
  $wrongPath = [pscustomobject]@{TaskName=$taskName;TaskPath='\Other\';State='Running'}
  if((Classify-TaskInventory -tasks @()) -cne 'ABSENT_UNPROVISIONED' -or
     (Classify-TaskInventory -tasks @($unrelated)) -cne 'ABSENT_UNPROVISIONED' -or
     (Classify-TaskInventory -tasks @($present)) -cne 'PRESENT_ACTIVE_UNATTESTED' -or
     (Classify-TaskInventory -tasks @($present,$present)) -cne 'PRESENT_UNKNOWN_UNATTESTED' -or
     (Classify-TaskInventory -tasks @($wrongPath)) -cne 'ABSENT_UNPROVISIONED') {
    throw 'P520_TASK_INVENTORY_SELFTEST_FAILED'
  }
  Mark 'P520_SUPERVISOR_READINESS_SELFTEST' 'PASS'
  exit 0
}
try {
  if($env:OS -cne 'Windows_NT' -or $env:COMPUTERNAME -ine 'DESKTOP-5FVJMET' -or
     -not [Environment]::Is64BitOperatingSystem) { throw 'P520_WRONG_DEVICE' }
  $pc = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  if($pc.Manufacturer -notmatch '(?i)lenovo' -or [string]$pc.Model -cne '30BFS1JG13') {
    throw 'P520_HARDWARE_ID_MISMATCH'
  }
  Mark 'P520_DEVICE_IDENTITY' 'PASS'

  # Enumerate the fixed root task namespace; query errors are never absence.
  try {
    $tasks = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop)
    $taskStatus = Classify-TaskInventory -tasks $tasks
  } catch {
    $taskStatus = 'QUERY_FAILED_UNATTESTED'
  }
  Mark 'P520_SUPERVISOR_TASK' $taskStatus

  # Neither task presence nor status verifies trusted executable, token ACL,
  # protected approval key, live named pipe or Windows service principal.
  Mark 'P520_SUPERVISOR_TASK_PROVENANCE' 'NOT_VERIFIED'
  Mark 'P520_SUPERVISOR_TOKEN_ACL' 'NOT_VERIFIED'
  Mark 'P520_SUPERVISOR_TRUST_ANCHOR' 'NOT_VERIFIED'

  # Do not execute PATH-supplied node.exe merely to read version.
  # File metadata is only advisory, never runtime/signature provenance.
  $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
  if($null -eq $node) {
    $nodeStatus = 'NOT_FOUND'
  } else {
    $nodeStatus = 'UNVERIFIED'
    try {
      $nodeFile = Get-Item -LiteralPath ([string]$node.Source) -ErrorAction Stop
      if((($nodeFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and
         $nodeFile.PSIsContainer -eq $false) {
        $major = [int]$nodeFile.VersionInfo.FileMajorPart
        if($major -gt 0) { $nodeStatus = Classify-Node $major }
      }
    } catch { $nodeStatus = 'UNVERIFIED' }
  }
  Mark 'P520_SUPERVISOR_NODE_RUNTIME' $nodeStatus

  $socketStatus = 'NOT_VERIFIED'
  try {
    $sockets = @(Get-NetTCPConnection -LocalPort 20145 -State Listen -ErrorAction Stop)
    $socketStatus = Classify-Listener -sockets $sockets
  } catch { $socketStatus = 'NOT_VERIFIED' }
  Mark 'P520_LLAMACPP_LISTENER' $socketStatus

  Mark 'P520_LAUNCHER_OWNER_APPROVAL' 'NOT_ESTABLISHED'
  Mark 'P520_PUBLISHER_IDENTITY' 'NOT_ESTABLISHED'
  Mark 'P520_SUPERVISOR_ACTIVATION' 'NOT_ATTEMPTED'
  Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
  Mark 'P520_READINESS_AUDIT' 'READ_ONLY_COMPLETE'
} catch {
  $reason = [string]$_.Exception.Message
  if($reason -notmatch '^[A-Z0-9_]{3,80}$') { $reason = 'READONLY_PRECONDITION_FAILED' }
  Mark 'P520_READINESS_AUDIT' ('BLOCKED_' + $reason)
  Mark 'P520_CODEBRIDGE_OMNIDESK' 'UNTOUCHED'
  exit 2
}
