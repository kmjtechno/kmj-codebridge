<#
.SYNOPSIS
  Read-only identity audit for an existing KMJ-CodeBridge-P720-Agent task.
.DESCRIPTION
  Does not register, enable, disable, start, stop, change or delete anything.
  Classifies an exact prepared DISABLED task separately from a foreign or
  already-enabled task. Never emits process arguments, usernames or secrets.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'KMJ-CodeBridge-P720-Agent'
$Sha = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$Root = 'D:\KMJ-HyperSpeed'
$Runtime = Join-Path $Root "codebridge-releases\$Sha"
$Entry = Join-Path $Runtime 'src\cli.js'
$Config = Join-Path $Root 'private\p720-codebridge\agent.json'
$ExpectedPipe = '\\.\pipe\kmj-codebridge-supervisor-p720'
$ExpectedToken = Join-Path $Root 'private\p720-codebridge\supervisor.token'
$ExpectedOrigin = 'https://github.com/kmjtechno/kmj-codebridge.git'

Write-Output 'KMJ_AGENT_TASK_AUDIT_MODE=READ_ONLY'
Write-Output 'KMJ_AGENT_TASK_AUDIT_WRITES=NONE'
Write-Output 'KMJ_AGENT_TASK_AUDIT_COMMAND_LINES=HIDDEN'
Write-Output 'KMJ_AGENT_TASK_AUDIT_SECRETS=HIDDEN'
try {
  if ($env:OS -ne 'Windows_NT') { throw 'AGENT_TASK_AUDIT_WINDOWS_ONLY' }
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $task) { throw 'AGENT_TASK_AUDIT_TASK_MISSING' }
  $state = [string]$task.State
  $allowedStates = @('Disabled','Ready','Running','Queued','Unknown')
  if ($state -notin $allowedStates) { $state = 'Unknown' }
  Write-Output "KMJ_AGENT_TASK_STATE=$state"

  foreach ($file in @($Entry,$Config,$ExpectedToken)) {
    $item = Get-Item -LiteralPath $file -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'AGENT_TASK_AUDIT_UNTRUSTED_FILE'
    }
  }
  $releaseItem = Get-Item -LiteralPath $Runtime -ErrorAction Stop
  if (-not $releaseItem.PSIsContainer -or
      ($releaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'AGENT_TASK_AUDIT_RELEASE_UNTRUSTED'
  }
  $git = (Get-Command git.exe -ErrorAction Stop).Source
  $gitHead = (& $git -C $Runtime rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]$gitHead -cne $Sha) {
    throw 'AGENT_TASK_AUDIT_SHA_MISMATCH'
  }
  $gitOrigin = (& $git -C $Runtime remote get-url origin 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]$gitOrigin -cne $ExpectedOrigin) {
    throw 'AGENT_TASK_AUDIT_ORIGIN_MISMATCH'
  }
  $gitStatus = @(& $git -C $Runtime status --porcelain=v1 --untracked-files=all 2>$null)
  if ($LASTEXITCODE -ne 0 -or $gitStatus.Count -ne 0) {
    throw 'AGENT_TASK_AUDIT_PINNED_RELEASE_CHANGED'
  }
  Write-Output 'KMJ_AGENT_TASK_RELEASE=PINNED_CLEAN'

  $cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  if ($cfg.id -cne 'kmj-p720-desktop-k3ahhem' -or
      @($cfg.projects).Count -ne 1 -or
      $cfg.projects[0].id -cne 'kmj-codebridge' -or
      [string]$cfg.supervisorPipe -cne $ExpectedPipe -or
      [string]$cfg.supervisorTokenFile -ine $ExpectedToken) {
    throw 'AGENT_TASK_AUDIT_AGENT_CONFIG_MISMATCH'
  }
  Write-Output 'KMJ_AGENT_TASK_AGENT_CONFIG=SCOPED'

  # The process command line is inspected ONLY to find the exact connected
  # agent. It is never printed, written to a file, or returned to ChatGPT.
  $agents = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.IndexOf($Entry,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine.IndexOf($Config,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine -match '\bagent\b'
    })
  Write-Output "KMJ_AGENT_TASK_ACTIVE_AGENT_COUNT=$($agents.Count)"
  if ($agents.Count -ne 1) { throw 'AGENT_TASK_AUDIT_AGENT_NOT_UNIQUE' }
  $agent = $agents[0]
  $node = [string]$agent.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($node)) {
    throw 'AGENT_TASK_AUDIT_AGENT_EXECUTABLE_UNKNOWN'
  }
  $owner = Invoke-CimMethod -InputObject $agent -MethodName GetOwner -ErrorAction Stop
  if ($owner.ReturnValue -ne 0 -or
      [string]::IsNullOrWhiteSpace($owner.Domain) -or
      [string]::IsNullOrWhiteSpace($owner.User)) {
    throw 'AGENT_TASK_AUDIT_AGENT_OWNER_UNKNOWN'
  }
  $ownerName = "$($owner.Domain)\$($owner.User)"
  $ownerSid = $null
  try {
    $account = [Security.Principal.NTAccount]::new([string]$owner.Domain,[string]$owner.User)
    $ownerSid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
  } catch {}
  $principalName = [string]$task.Principal.UserId
  $principalMatches = $principalName -ine '' -and
    ($principalName -ieq $ownerName -or
     ($ownerSid -and $principalName -ieq $ownerSid))
  $principalPolicy = ([string]$task.Principal.LogonType -eq 'S4U') -and
    ([string]$task.Principal.RunLevel -eq 'Limited')
  $principalValid = $principalMatches -and $principalPolicy
  Write-Output "KMJ_AGENT_TASK_PRINCIPAL=$(if($principalValid){'MATCH'}else{'MISMATCH'})"

  $actions = @($task.Actions)
  $expectedArguments = '"' + $Entry + '" agent "' + $Config + '"'
  $actionValid = $actions.Count -eq 1 -and
    [string]$actions[0].Execute -ieq $node -and
    [string]$actions[0].Arguments -ceq $expectedArguments -and
    [string]$actions[0].WorkingDirectory -ieq $Runtime
  Write-Output "KMJ_AGENT_TASK_ACTION=$(if($actionValid){'MATCH'}else{'MISMATCH'})"

  $triggers = @($task.Triggers)
  $triggerValid = $triggers.Count -eq 1 -and
    [string]$triggers[0].CimClass.CimClassName -eq 'MSFT_TaskBootTrigger'
  $settingsValid = ([string]$task.Settings.MultipleInstances -eq 'IgnoreNew') -and
    ([int]$task.Settings.RestartCount -eq 3)
  $policyValid = $triggerValid -and $settingsValid
  Write-Output "KMJ_AGENT_TASK_RECOVERY_POLICY=$(if($policyValid){'MATCH'}else{'MISMATCH'})"

  if (-not ($principalValid -and $actionValid -and $policyValid)) {
    Write-Output 'KMJ_AGENT_TASK_AUDIT=CONFLICT_NO_CHANGES'
    exit 3
  }
  Write-Output 'KMJ_AGENT_TASK_IDENTITY=EXACT'
  if ($state -ne 'Disabled') {
    Write-Output 'KMJ_AGENT_TASK_AUDIT=ALREADY_ENABLED_OR_RUNNING_REVIEW_REQUIRED'
    exit 4
  }
  # This is NOT permission to enable the task or run a second agent.
  Write-Output 'KMJ_AGENT_TASK_AUDIT=REUSABLE_DISABLED'
  Write-Output 'KMJ_AGENT_TASK_NEXT=GUARDED_TAKEOVER_NOT_YET_ACTIVE'
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{3,80}$') {
    $code = 'AGENT_TASK_AUDIT_UNCLASSIFIED'
  }
  Write-Output "KMJ_AGENT_TASK_AUDIT_BLOCKER=$code"
  Write-Output 'KMJ_AGENT_TASK_AUDIT=BLOCKED_NO_CHANGES'
  exit 2
}
