<#
.SYNOPSIS
  Read-only classification of an existing P720 CodeBridge agent task principal.
.DESCRIPTION
  Never prints an account name, SID, token, file content or process command.
  Never modifies a scheduled task, active agent, supervisor or CineCore.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'KMJ-CodeBridge-P720-Agent'
$Root = 'D:\KMJ-HyperSpeed'
$Sha = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$Runtime = Join-Path $Root "codebridge-releases\$Sha"
$Entry = Join-Path $Runtime 'src\cli.js'
$Config = Join-Path $Root 'private\p720-codebridge\agent.json'

function SidOf([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
  try {
    if ($Name.StartsWith('S-1-', [StringComparison]::OrdinalIgnoreCase)) {
      return ([Security.Principal.SecurityIdentifier]::new($Name)).Value
    }
    return ([Security.Principal.NTAccount]::new($Name)).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch { return $null }
}

Write-Output 'KMJ_PRINCIPAL_DIAG=READ_ONLY'
Write-Output 'KMJ_PRINCIPAL_DIAG_WRITES=NONE'
Write-Output 'KMJ_PRINCIPAL_DIAG_IDENTITIES=HIDDEN'
Write-Output 'KMJ_PRINCIPAL_DIAG_COMMAND_LINES=HIDDEN'
try {
  if ($env:OS -ne 'Windows_NT') { throw 'PRINCIPAL_DIAG_WINDOWS_ONLY' }
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  $taskState = [string]$task.State
  if ($taskState -notin @('Disabled','Ready','Running','Queued')) {
    $taskState = 'UNKNOWN'
  }
  Write-Output "KMJ_PRINCIPAL_TASK_STATE=$taskState"
  $actions = @($task.Actions)
  if ($actions.Count -ne 1) { throw 'PRINCIPAL_DIAG_ACTION_COUNT_INVALID' }
  $expectedArgs = '"' + $Entry + '" agent "' + $Config + '"'
  if ([string]$actions[0].Arguments -cne $expectedArgs -or
      [string]$actions[0].WorkingDirectory -ine $Runtime) {
    throw 'PRINCIPAL_DIAG_FOREIGN_TASK_ACTION'
  }
  $agents = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.IndexOf($Entry,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine.IndexOf($Config,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine -match '\bagent\b'
    })
  if ($agents.Count -ne 1) { throw 'PRINCIPAL_DIAG_AGENT_NOT_UNIQUE' }
  if ([string]$actions[0].Execute -ine [string]$agents[0].ExecutablePath) {
    throw 'PRINCIPAL_DIAG_AGENT_EXECUTABLE_MISMATCH'
  }
  Write-Output 'KMJ_PRINCIPAL_TASK_ACTION=APPROVED'

  $owner = Invoke-CimMethod -InputObject $agents[0] -MethodName GetOwner -ErrorAction Stop
  if ($owner.ReturnValue -ne 0 -or
      [string]::IsNullOrWhiteSpace($owner.User) -or
      [string]::IsNullOrWhiteSpace($owner.Domain)) {
    throw 'PRINCIPAL_DIAG_AGENT_OWNER_UNAVAILABLE'
  }
  $ownerName = "$($owner.Domain)\$($owner.User)"
  $taskAccount = [string]$task.Principal.UserId
  $ownerSid = SidOf $ownerName
  $taskSid = SidOf $taskAccount
  $matches = $taskAccount -ine '' -and
    ($taskAccount -ieq $ownerName -or
     ($ownerSid -and $taskSid -and $ownerSid -ieq $taskSid))
  $identity = if ($matches) {
    'MATCH'
  } elseif (-not $ownerSid -or -not $taskSid) {
    'UNRESOLVED'
  } else {
    'MISMATCH'
  }
  $rawLogon = [string]$task.Principal.LogonType
  $rawLevel = [string]$task.Principal.RunLevel
  $logon = if ($rawLogon -eq 'S4U') {
    'S4U'
  } elseif ($rawLogon -eq 'Password') {
    'PASSWORD'
  } elseif ($rawLogon -eq 'Interactive') {
    'INTERACTIVE'
  } elseif ($rawLogon -eq 'InteractiveOrPassword') {
    'INTERACTIVE_OR_PASSWORD'
  } elseif ($rawLogon -eq 'ServiceAccount') {
    'SERVICE_ACCOUNT'
  } else {
    'OTHER_OR_UNKNOWN'
  }
  $level = if ($rawLevel -eq 'Limited') {
    'LIMITED'
  } elseif ($rawLevel -eq 'Highest') {
    'HIGHEST'
  } else {
    'OTHER_OR_UNKNOWN'
  }

  Write-Output "KMJ_PRINCIPAL_IDENTITY=$identity"
  Write-Output "KMJ_PRINCIPAL_LOGON=$logon"
  Write-Output "KMJ_PRINCIPAL_RUN_LEVEL=$level"
  if ($matches -and $logon -eq 'S4U' -and $level -eq 'LIMITED') {
    Write-Output 'KMJ_PRINCIPAL_DIAG_RESULT=EXACT_PRINCIPAL_MATCH'
  } else {
    Write-Output 'KMJ_PRINCIPAL_DIAG_RESULT=MISMATCH_NO_CHANGES'
    exit 3
  }
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{3,80}$') {
    $code = 'PRINCIPAL_DIAG_UNCLASSIFIED'
  }
  Write-Output "KMJ_PRINCIPAL_DIAG_BLOCKER=$code"
  Write-Output 'KMJ_PRINCIPAL_DIAG_RESULT=BLOCKED_NO_CHANGES'
  exit 2
}
