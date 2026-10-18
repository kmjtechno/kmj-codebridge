<#
.SYNOPSIS
  READ-ONLY readiness gate for the existing P720 CodeBridge Agent Scheduled Task.
.DESCRIPTION
  Checks the *already-running* pinned agent and an *already-disabled* exact task.
  It never starts/stops a process, changes a task, writes a file, or reads secrets.
  A passing inventory is NOT approval to take over: an S4U task has not yet proven
  equivalent network/enrollment access, gateway heartbeat, or rollback.
#>
[CmdletBinding()]
param([switch]$SelfTest)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = 'D:\KMJ-HyperSpeed'
$Sha = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$Release = Join-Path $Root "codebridge-releases\$Sha"
$Entry = Join-Path $Release 'src\cli.js'
$Config = Join-Path $Root 'private\p720-codebridge\agent.json'
$State = Join-Path $Root 'private\p720-codebridge\state'
$SupervisorTask = 'KMJ-CodeBridge-Supervisor'
$AgentTask = 'KMJ-CodeBridge-P720-Agent'
$ExpectedPipe = '\\.\pipe\kmj-codebridge-supervisor-p720'
$ExpectedToken = Join-Path $Root 'private\p720-codebridge\supervisor.token'

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

function AssertFile([string]$Target) {
  $item = Get-Item -LiteralPath $Target -ErrorAction Stop
  if ($item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'TAKEOVER_UNTRUSTED_FILE'
  }
}

function AssertDirectory([string]$Target) {
  $item = Get-Item -LiteralPath $Target -ErrorAction Stop
  if (-not $item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'TAKEOVER_UNTRUSTED_DIRECTORY'
  }
}

function AssertIdle {
  foreach ($bucket in @('jobs','autopilot')) {
    $folder = Join-Path $State $bucket
    AssertDirectory $folder
    $items = @(Get-ChildItem -LiteralPath $folder -File -Recurse -Filter '*.json' -ErrorAction Stop)
    if ($items.Count -gt 10000) { throw 'TAKEOVER_JOURNAL_TOO_LARGE' }
    foreach ($item in $items) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
          $item.Length -gt 4194304) {
        throw 'TAKEOVER_JOURNAL_UNTRUSTED'
      }
      try {
        $data = Get-Content -LiteralPath $item.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
      } catch { throw 'TAKEOVER_JOURNAL_INVALID' }
      if ($bucket -eq 'jobs') {
        if (@($data.PSObject.Properties.Name) -notcontains 'state') {
          throw 'TAKEOVER_JOB_STATE_MISSING'
        }
        if ([string]$data.state -in @('queued','running')) {
          throw 'TAKEOVER_JOB_ACTIVE'
        }
      } else {
        if (@($data.PSObject.Properties.Name) -notcontains 'tasks') {
          throw 'TAKEOVER_AUTOPILOT_STATE_MISSING'
        }
        foreach ($work in @($data.tasks)) {
          if ([string]$work.state -in @('running','claimed')) {
            throw 'TAKEOVER_AUTOPILOT_ACTIVE'
          }
        }
      }
    }
  }
}

Write-Output 'KMJ_TASK_TAKEOVER_PREFLIGHT=READ_ONLY'
Write-Output 'KMJ_TASK_TAKEOVER_WRITES=NONE'
Write-Output 'KMJ_TASK_TAKEOVER_IDENTITIES=HIDDEN'
Write-Output 'KMJ_TASK_TAKEOVER_SECRETS=HIDDEN'
Write-Output 'KMJ_TASK_TAKEOVER_COMMAND_LINES=HIDDEN'

try {
  if ($env:OS -ne 'Windows_NT') { throw 'TAKEOVER_WINDOWS_ONLY' }

  if ($SelfTest) {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (SidOf $me.Name) -or
        (SidOf $me.Name) -cne (SidOf $me.User.Value) -or
        (SidOf 'S-1-5-18') -ceq (SidOf 'S-1-5-19') -or
        (SidOf '') -ne $null) {
      throw 'TAKEOVER_SID_SELFTEST_FAILED'
    }
    Write-Output 'KMJ_TASK_TAKEOVER_SID_SELFTEST=PASS'
    Write-Output 'KMJ_TASK_TAKEOVER_NOT_ACTIVATED=YES'
    exit 0
  }

  $principal = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
  )
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'TAKEOVER_ADMIN_REQUIRED'
  }
  AssertDirectory $Root
  AssertDirectory $Release
  AssertDirectory $State
  foreach ($f in @($Entry,$Config,$ExpectedToken,(Join-Path $State 'agent.lock'))) {
    AssertFile $f
  }

  $git = (Get-Command git.exe -ErrorAction Stop).Source
  $head = (& $git -C $Release rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]$head -cne $Sha) {
    throw 'TAKEOVER_RELEASE_SHA_CHANGED'
  }
  $origin = (& $git -C $Release remote get-url origin 2>$null)
  if ($LASTEXITCODE -ne 0 -or
      [string]$origin -cne 'https://github.com/kmjtechno/kmj-codebridge.git') {
    throw 'TAKEOVER_RELEASE_ORIGIN_CHANGED'
  }
  $dirty = @(& $git --no-optional-locks -C $Release status --porcelain=v1 --untracked-files=all 2>$null)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw 'TAKEOVER_RELEASE_DIRTY'
  }
  Write-Output 'KMJ_TASK_TAKEOVER_RELEASE=PINNED_CLEAN'

  $cfg = Get-Content -LiteralPath $Config -Raw -ErrorAction Stop | ConvertFrom-Json
  if ($cfg.id -cne 'kmj-p720-desktop-k3ahhem' -or
      @($cfg.projects).Count -ne 1 -or
      $cfg.projects[0].id -cne 'kmj-codebridge' -or
      [string]$cfg.stateDir -ine $State -or
      [string]$cfg.supervisorPipe -cne $ExpectedPipe -or
      [string]$cfg.supervisorTokenFile -ine $ExpectedToken) {
    throw 'TAKEOVER_CONFIG_SCOPE_MISMATCH'
  }
  Write-Output 'KMJ_TASK_TAKEOVER_CONFIG=SCOPED'

  $nodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
  if (@($nodes | Where-Object { -not $_.CommandLine }).Count -gt 0) {
    throw 'TAKEOVER_PROCESS_VISIBILITY_INCOMPLETE'
  }
  $matches = @($nodes | Where-Object {
    $_.CommandLine.IndexOf($Entry,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine.IndexOf($Config,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -match '\bagent\b'
  })
  if ($matches.Count -ne 1) { throw 'TAKEOVER_AGENT_NOT_UNIQUE' }
  $agent = $matches[0]
  if ([string]::IsNullOrWhiteSpace([string]$agent.ExecutablePath)) {
    throw 'TAKEOVER_NODE_EXECUTABLE_UNKNOWN'
  }
  $lock = Get-Content -LiteralPath (Join-Path $State 'agent.lock') -Raw -ErrorAction Stop |
    ConvertFrom-Json
  if ([int]$lock.pid -ne [int]$agent.ProcessId -or
      [string]::IsNullOrWhiteSpace([string]$lock.owner)) {
    throw 'TAKEOVER_AGENT_LOCK_MISMATCH'
  }
  Write-Output 'KMJ_TASK_TAKEOVER_AGENT=UNIQUE_LOCK_MATCH'

  $task = Get-ScheduledTask -TaskName $AgentTask -TaskPath '\' -ErrorAction Stop
  if ([string]$task.State -cne 'Disabled' -or @($task.Actions).Count -ne 1) {
    throw 'TAKEOVER_TASK_NOT_DISABLED_EXACT'
  }
  $expectedArgs = '"' + $Entry + '" agent "' + $Config + '"'
  if ([string]$task.Actions[0].Execute -ine [string]$agent.ExecutablePath -or
      [string]$task.Actions[0].Arguments -cne $expectedArgs -or
      [string]$task.Actions[0].WorkingDirectory -ine $Release) {
    throw 'TAKEOVER_TASK_ACTION_MISMATCH'
  }

  $owner = Invoke-CimMethod -InputObject $agent -MethodName GetOwner -ErrorAction Stop
  if ($owner.ReturnValue -ne 0 -or
      [string]::IsNullOrWhiteSpace($owner.User) -or
      [string]::IsNullOrWhiteSpace($owner.Domain)) {
    throw 'TAKEOVER_AGENT_OWNER_UNKNOWN'
  }
  $ownerSid = SidOf "$($owner.Domain)\$($owner.User)"
  $taskSid = SidOf ([string]$task.Principal.UserId)
  if (-not $ownerSid -or -not $taskSid -or $ownerSid -cne $taskSid) {
    throw 'TAKEOVER_PRINCIPAL_SID_MISMATCH'
  }
  if ([string]$task.Principal.LogonType -cne 'S4U' -or
      [string]$task.Principal.RunLevel -cne 'Limited') {
    throw 'TAKEOVER_PRINCIPAL_POLICY_CHANGED'
  }
  $triggers = @($task.Triggers)
  if ($triggers.Count -ne 1 -or
      [string]$triggers[0].CimClass.CimClassName -cne 'MSFT_TaskBootTrigger' -or
      [string]$task.Settings.MultipleInstances -cne 'IgnoreNew' -or
      [int]$task.Settings.RestartCount -ne 3) {
    throw 'TAKEOVER_RECOVERY_POLICY_CHANGED'
  }
  Write-Output 'KMJ_TASK_TAKEOVER_DISABLED_TASK=EXACT'
  Write-Output 'KMJ_TASK_TAKEOVER_PRINCIPAL=SID_MATCH_S4U_LIMITED'

  $svc = Get-ScheduledTask -TaskName $SupervisorTask -TaskPath '\' -ErrorAction Stop
  if ([string]$svc.State -cne 'Running') {
    throw 'TAKEOVER_SUPERVISOR_TASK_NOT_RUNNING'
  }
  Write-Output 'KMJ_TASK_TAKEOVER_SUPERVISOR_TASK=RUNNING'
  AssertIdle
  Write-Output 'KMJ_TASK_TAKEOVER_LOCAL_JOURNALS=IDLE'

  # No network probe is run under the task's S4U identity; that would require
  # starting a task. A normal user agent heartbeat does not establish equivalent
  # S4U outbound network access, secret decryption, or recovery permissions.
  Write-Output 'KMJ_TASK_TAKEOVER_CANARY=S4U_NETWORK_SESSION_UNVERIFIED'
  Write-Output 'KMJ_TASK_TAKEOVER_HEARTBEAT=TASK_CONTEXT_NOT_PROVEN'
  Write-Output 'KMJ_TASK_TAKEOVER_ROLLBACK=NOT_EXECUTED'
  Write-Output 'KMJ_TASK_TAKEOVER_ACTIVATED=NO'
  Write-Output 'KMJ_TASK_TAKEOVER_READY=NO'
  exit 3
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{3,80}$') {
    $code = 'TAKEOVER_UNCLASSIFIED'
  }
  Write-Output "KMJ_TASK_TAKEOVER_BLOCKER=$code"
  Write-Output 'KMJ_TASK_TAKEOVER_ACTIVATED=NO'
  Write-Output 'KMJ_TASK_TAKEOVER_READY=NO'
  exit 2
}
