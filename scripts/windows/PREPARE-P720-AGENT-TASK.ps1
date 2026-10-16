<#
.SYNOPSIS
  Prepare a DISABLED Windows Scheduled Task for the already-connected
  P720 CodeBridge agent without interrupting its active process.
.DESCRIPTION
  Read-only by default. With -Apply, verifies the single live agent's
  pinned Node binary, release commit, config and Windows owner; registers
  a disabled task with a fixed argv, zero task time limit and startup
  trigger. Never ends/starts the existing agent, modifies config, changes
  the native supervisor, or touches CineCore.
#>
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'KMJ-CodeBridge-P720-Agent'
$Sha = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$Root = 'D:\KMJ-HyperSpeed'
$Runtime = Join-Path $Root "codebridge-releases\$Sha"
$Entry = Join-Path $Runtime 'src\cli.js'
$Config = Join-Path $Root 'private\p720-codebridge\agent.json'
$BackupRoot = Join-Path $Root 'private\backups'
$ExpectedOrigin = 'https://github.com/kmjtechno/kmj-codebridge.git'

function Assert-File([string]$Target) {
  $item = Get-Item -LiteralPath $Target -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'AGENT_TASK_UNTRUSTED_FILE'
  }
}
function Assert-Directory([string]$Target) {
  $item = Get-Item -LiteralPath $Target -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'AGENT_TASK_UNTRUSTED_DIRECTORY'
  }
}
function UniqueAgent {
  $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.IndexOf($Config,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine.IndexOf($Entry,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine -match '\bagent\b'
    })
  if ($matches.Count -ne 1) { throw 'AGENT_TASK_EXISTING_AGENT_NOT_UNIQUE' }
  return $matches[0]
}
try {
  if ($env:OS -ne 'Windows_NT') { throw 'AGENT_TASK_WINDOWS_ONLY' }
  foreach ($f in @($Entry,$Config)) { Assert-File $f }
  foreach ($dir in @($Runtime,$BackupRoot)) { Assert-Directory $dir }
  if (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue) {
    throw 'AGENT_TASK_ALREADY_EXISTS'
  }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Assert-File $node
  if ((& $node --version) -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
    throw 'AGENT_TASK_NODE24_REQUIRED'
  }
  $git = (Get-Command git.exe -ErrorAction Stop).Source
  $actual = (& $git -C $Runtime rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $actual -cne $Sha) {
    throw 'AGENT_TASK_PINNED_SHA_MISMATCH'
  }
  $origin = (& $git -C $Runtime remote get-url origin).Trim()
  if ($LASTEXITCODE -ne 0 -or $origin -cne $ExpectedOrigin) {
    throw 'AGENT_TASK_UNTRUSTED_ORIGIN'
  }
  $changes = @(& $git -C $Runtime status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $changes.Count -ne 0) {
    throw 'AGENT_TASK_RELEASE_NOT_IMMUTABLE'
  }
  $cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  if ($cfg.id -cne 'kmj-p720-desktop-k3ahhem' -or
      @($cfg.projects).Count -ne 1 -or
      $cfg.projects[0].id -cne 'kmj-codebridge' -or
      [string]$cfg.supervisorPipe -cne '\\.\pipe\kmj-codebridge-supervisor-p720' -or
      [string]$cfg.supervisorTokenFile -ine (Join-Path $Root 'private\p720-codebridge\supervisor.token')) {
    throw 'AGENT_TASK_CONFIG_SCOPE_INVALID'
  }
  $agent = UniqueAgent
  if ([string]$agent.ExecutablePath -ine $node) {
    throw 'AGENT_TASK_RUNNING_NODE_MISMATCH'
  }
  $owner = Invoke-CimMethod -InputObject $agent -MethodName GetOwner -ErrorAction Stop
  if ($owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.User) -or
      [string]::IsNullOrWhiteSpace($owner.Domain)) {
    throw 'AGENT_TASK_OWNER_UNREADABLE'
  }
  $runningOwner = "$($owner.Domain)\$($owner.User)"
  $currentOwner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ($runningOwner -ine $currentOwner) {
    throw 'AGENT_TASK_OWNER_MISMATCH'
  }
  Write-Output 'KMJ_AGENT_TASK_PREFLIGHT=PASS'
  Write-Output 'KMJ_AGENT_TASK_CURRENT_AGENT=UNTOUCHED'
  Write-Output 'KMJ_AGENT_TASK_SUPERVISOR=UNTOUCHED'
  Write-Output 'KMJ_AGENT_TASK_CINECORE=UNTOUCHED'
  Write-Output 'KMJ_AGENT_TASK_CHECKOUT=UNTOUCHED'
  if (-not $Apply) {
    Write-Output 'KMJ_AGENT_TASK_MODE=READ_ONLY'
    return
  }
  $principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
  )
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'AGENT_TASK_ADMIN_REQUIRED'
  }
  $again = UniqueAgent
  if ([int]$again.ProcessId -ne [int]$agent.ProcessId -or
      (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue)) {
    throw 'AGENT_TASK_STATE_CHANGED'
  }
  $action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $Entry + '" agent "' + $Config + '"') -WorkingDirectory $Runtime
  $identity = New-ScheduledTaskPrincipal -UserId $currentOwner -LogonType S4U -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1)) -StartWhenAvailable
  # The task MUST remain disabled: a second live agent would conflict with
  # the existing device enrollment and in-flight project operations.
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Principal $identity -Trigger $trigger -Settings $settings -ErrorAction Stop | Out-Null
  Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop | Out-Null
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  if ($task.State -ne 'Disabled' -or @($task.Actions).Count -ne 1 -or
      $task.Actions[0].Execute -ine $node -or
      $task.Actions[0].Arguments -cne $action.Arguments -or
      $task.Actions[0].WorkingDirectory -ine $Runtime) {
    throw 'AGENT_TASK_DISABLED_IDENTITY_UNVERIFIED'
  }
  $still = UniqueAgent
  if ([int]$still.ProcessId -ne [int]$agent.ProcessId) {
    throw 'AGENT_TASK_ACTIVE_AGENT_CHANGED'
  }
  Write-Output 'KMJ_AGENT_TASK_PREPARED=DISABLED'
  Write-Output 'KMJ_AGENT_TASK_ACTIVATED=NO'
  Write-Output 'KMJ_AGENT_TASK_NEXT=GUARDED_TAKEOVER_AND_HEARTBEAT_REQUIRED'
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{3,80}$') { $code = 'AGENT_TASK_UNCLASSIFIED_FAILURE' }
  Write-Output "KMJ_AGENT_TASK_BLOCKER=$code"
  throw 'KMJ_AGENT_TASK_PREPARATION_FAILED'
}
