<#
.SYNOPSIS
  Guarded first-party P720 native-supervisor agent handoff.
.DESCRIPTION
  Requires a running, HMAC-verified native supervisor and a byte-verified
  proposed config that differs ONLY by the approved pipe and token path.
  Stages no new installs. Touches only the exact scoped CodeBridge agent.
  Stops/restarts it only after idle + backup checks, with rollback on failure.
  The CineCore agent and the dirty project checkout remain untouched.
#>
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'KMJ-CodeBridge-Supervisor'
$Sha = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$Private = 'D:\KMJ-HyperSpeed\private\p720-codebridge'
$Config = Join-Path $Private 'agent.json'
$Proposed = "$Config.proposed"
$State = Join-Path $Private 'state'
$Repo = 'D:\KMJ-HyperSpeed\projects\kmj-codebridge'
$Release = Join-Path 'D:\KMJ-HyperSpeed\codebridge-releases' $Sha
$BackupRoot = 'D:\KMJ-HyperSpeed\private\backups'
$LogRoot = 'D:\KMJ-HyperSpeed\logs'
$Guard = Join-Path $PSScriptRoot 'verify-p720-agent-handoff.mjs'
$Hmac = Join-Path $PSScriptRoot 'verify-p720-supervisor.mjs'
$NewEntry = Join-Path $Release 'src\cli.js'
$OldEntry = Join-Path $Repo 'src\cli.js'
$oldPid = 0
$newPid = 0
$oldStopped = $false
$switched = $false
$backupFile = $null
$node = $null

function HashFile([string]$File) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant()
}
function Assert-Idle {
  foreach ($bucket in @('jobs','autopilot')) {
    $folder = Join-Path $State $bucket
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
      throw 'HANDOFF_JOURNAL_MISSING'
    }
    $items = @(Get-ChildItem -LiteralPath $folder -Recurse -File -Filter '*.json' -ErrorAction Stop)
    if ($items.Count -gt 10000) { throw 'HANDOFF_JOURNAL_OVERFLOW' }
    foreach ($item in $items) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
          $item.Length -gt 4194304) { throw 'HANDOFF_JOURNAL_UNTRUSTED' }
      try {
        $data = Get-Content -LiteralPath $item.FullName -Raw | ConvertFrom-Json
      } catch { throw 'HANDOFF_JOURNAL_CORRUPT' }
      if ($bucket -eq 'jobs') {
        if (@($data.PSObject.Properties.Name) -notcontains 'state') {
          throw 'HANDOFF_JOURNAL_INVALID'
        }
        if ([string]$data.state -in @('running','queued')) {
          throw 'HANDOFF_ACTIVE_JOBS'
        }
      } else {
        if (@($data.PSObject.Properties.Name) -notcontains 'tasks') {
          throw 'HANDOFF_AUTOPILOT_INVALID'
        }
        foreach ($task in @($data.tasks)) {
          if ([string]$task.state -eq 'running') {
            throw 'HANDOFF_ACTIVE_AUTOPILOT'
          }
        }
      }
    }
  }
}
function ScopedAgents {
  $items = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.IndexOf($Config,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine -match 'src[\\/]cli\.js' -and
      $_.CommandLine -match '\bagent\b'
    })
  if ($items.Count -gt 1) { throw 'HANDOFF_MULTIPLE_AGENTS' }
  return $items
}
function StartScoped([string]$Entry,[string]$WorkDir,[string]$Prefix) {
  New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
  $p = Start-Process -FilePath $node -ArgumentList @($Entry,'agent',$Config) -WorkingDirectory $WorkDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogRoot "$Prefix-out.log") -RedirectStandardError (Join-Path $LogRoot "$Prefix-err.log") -PassThru
  return [int]$p.Id
}
function ConfirmAgent([int]$AgentProcessId,[string]$Entry,[datetime]$Since) {
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $AgentProcessId" -ErrorAction SilentlyContinue
    if (-not $process -or
        $process.CommandLine.IndexOf($Entry,[StringComparison]::OrdinalIgnoreCase) -lt 0) {
      return $false
    }
    $scoped = @(ScopedAgents)
    if ($scoped.Count -ne 1 -or [int]$scoped[0].ProcessId -ne $AgentProcessId) { return $false }
    $connection = Join-Path $State 'connection.json'
    if (Test-Path -LiteralPath $connection -PathType Leaf) {
      try {
        $stamp = [datetime]::Parse([string](Get-Content -LiteralPath $connection -Raw | ConvertFrom-Json).connectedAt).ToUniversalTime()
        if ($stamp -ge $Since.AddSeconds(-2)) { return $true }
      } catch {}
    }
  }
  return $false
}
function RestoreConfig {
  if (-not $switched) { return }
  if (-not $backupFile -or -not (Test-Path -LiteralPath $backupFile -PathType Leaf)) {
    throw 'HANDOFF_ROLLBACK_BACKUP_MISSING'
  }
  $restore = "$Config.rollback-$( [guid]::NewGuid().ToString('N') )"
  Copy-Item -LiteralPath $backupFile -Destination $restore -ErrorAction Stop
  Set-Acl -LiteralPath $restore -AclObject (Get-Acl -LiteralPath $Config) -ErrorAction Stop
  [IO.File]::Replace($restore,$Config,$null)
  if ((HashFile $Config) -cne $originalHash) { throw 'HANDOFF_ROLLBACK_HASH_MISMATCH' }
  Write-Output 'KMJ_HANDOFF_CONFIG_ROLLBACK=PASS'
}

try {
  if ($env:OS -ne 'Windows_NT') { throw 'HANDOFF_WINDOWS_ONLY' }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $version = (& $node --version)
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or
      [int]$Matches[1] -lt 24) { throw 'HANDOFF_NODE24_REQUIRED' }
  foreach ($file in @($Guard,$Hmac,$Config,$Proposed,$NewEntry,$OldEntry)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'HANDOFF_REQUIRED_FILE_MISSING' }
  }
  foreach ($folder in @($Private,$State,$Repo,$Release,$BackupRoot)) {
    if (-not (Test-Path -LiteralPath $folder -PathType Container) -or
        ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'HANDOFF_DIRECTORY_INVALID'
    }
  }
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  if ($task.State -ne 'Running') { throw 'HANDOFF_SUPERVISOR_NOT_RUNNING' }
  $git = (Get-Command git.exe -ErrorAction Stop).Source
  $shaActual = (& $git -C $Release rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $shaActual -cne $Sha) { throw 'HANDOFF_RELEASE_SHA_INVALID' }
  $origin = (& $git -C $Release remote get-url origin).Trim()
  if ($LASTEXITCODE -ne 0 -or $origin -cne 'https://github.com/kmjtechno/kmj-codebridge.git') {
    throw 'HANDOFF_RELEASE_ORIGIN_INVALID'
  }
  $manifests = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $BackupRoot -Filter manifest.json -Recurse -File -ErrorAction Stop)) {
    try {
      $m = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
      if ($m.schema -eq 2 -and $m.taskName -ceq $TaskName) { $manifests += $file }
    } catch {}
  }
  if ($manifests.Count -ne 1) { throw 'HANDOFF_MANIFEST_NOT_UNIQUE' }
  $backupDir = $manifests[0].DirectoryName
  & $node $Guard $backupDir | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'HANDOFF_PROPOSAL_INTEGRITY_FAILED' }
  & $node $Hmac $backupDir | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'HANDOFF_HMAC_FAILED' }

  $agents = @(ScopedAgents)
  if ($agents.Count -ne 1) { throw 'HANDOFF_EXISTING_AGENT_NOT_UNIQUE' }
  $oldPid = [int]$agents[0].ProcessId
  if ([string]$agents[0].ExecutablePath -ine $node) {
    throw 'HANDOFF_AGENT_NODE_EXECUTABLE_MISMATCH'
  }
  if ([string]$agents[0].CommandLine -match '(?i)codebridge-releases[\\/]') {
    throw 'HANDOFF_EXISTING_AGENT_RELEASE_REQUIRES_REVIEW'
  }
  Assert-Idle
  $originalHash = HashFile $Config
  $proposalHash = HashFile $Proposed
  Write-Output 'KMJ_HANDOFF_PREFLIGHT=PASS'
  Write-Output 'KMJ_HANDOFF_HMAC=PASS'
  Write-Output 'KMJ_CINECORE=UNTOUCHED'
  Write-Output 'KMJ_DIRTY_CHECKOUT=UNTOUCHED'
  if (-not $Apply) {
    Write-Output 'KMJ_HANDOFF_MODE=READ_ONLY'
    return
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'HANDOFF_ADMIN_REQUIRED'
  }
  # Second preflight immediately before changing a protected file.
  Assert-Idle
  $still = @(ScopedAgents)
  if ($still.Count -ne 1 -or [int]$still[0].ProcessId -ne $oldPid) {
    throw 'HANDOFF_AGENT_CHANGED_DURING_PREFLIGHT'
  }
  if ((HashFile $Config) -cne $originalHash -or (HashFile $Proposed) -cne $proposalHash) {
    throw 'HANDOFF_CONFIG_CHANGED_DURING_PREFLIGHT'
  }
  $suffix = [guid]::NewGuid().ToString('N')
  $temp = "$Config.handoff-$suffix.tmp"
  $backupFile = "$Config.handoff-$suffix.backup"
  Copy-Item -LiteralPath $Proposed -Destination $temp -ErrorAction Stop
  Set-Acl -LiteralPath $temp -AclObject (Get-Acl -LiteralPath $Config) -ErrorAction Stop
  [IO.File]::Replace($temp,$Config,$backupFile)
  $switched = $true
  if ((HashFile $Config) -cne $proposalHash -or (HashFile $backupFile) -cne $originalHash) {
    throw 'HANDOFF_ATOMIC_CONFIG_SWAP_FAILED'
  }
  Write-Output 'KMJ_HANDOFF_BACKUP=CREATED'
  Write-Output 'KMJ_HANDOFF_CONFIG=APPLIED'
  $oldStopped = $true
  Stop-Process -Id $oldPid -ErrorAction Stop
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
    throw 'HANDOFF_ORIGINAL_AGENT_STILL_RUNNING'
  }
  $since = [datetime]::UtcNow
  $newPid = StartScoped $NewEntry $Release ('handoff-' + $Sha.Substring(0,12))
  if (-not (ConfirmAgent $newPid $NewEntry $since)) {
    throw 'HANDOFF_NEW_AGENT_HEARTBEAT_FAILED'
  }
  & $node $Hmac $backupDir | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'HANDOFF_POSTSTART_HMAC_FAILED' }
  Write-Output 'KMJ_HANDOFF_NEW_AGENT_HEARTBEAT=PASS'
  Write-Output 'KMJ_HANDOFF_SUPERVISOR_HMAC=PASS'
  Write-Output 'KMJ_HANDOFF=PASS'
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{3,80}$') { $code = 'HANDOFF_UNCLASSIFIED_FAILURE' }
  Write-Output "KMJ_HANDOFF_BLOCKER=$code"
  if ($oldStopped -or $switched) {
    try {
      if ($newPid -gt 0 -and (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $newPid -ErrorAction Stop
      }
      RestoreConfig
      if ($oldStopped) {
        $agentsNow = @(ScopedAgents)
        if ($agentsNow.Count -eq 1 -and [int]$agentsNow[0].ProcessId -eq $oldPid) {
          Write-Output 'KMJ_HANDOFF_OLD_AGENT_ROLLBACK=ORIGINAL_STILL_RUNNING'
        } elseif ($agentsNow.Count -eq 0) {
          $rollbackSince = [datetime]::UtcNow
          $rollbackPid = StartScoped $OldEntry $Repo ('rollback-' + $Sha.Substring(0,12))
          if (-not (ConfirmAgent $rollbackPid $OldEntry $rollbackSince)) {
            throw 'HANDOFF_ROLLBACK_HEARTBEAT_FAILED'
          }
          Write-Output 'KMJ_HANDOFF_OLD_AGENT_ROLLBACK=PASS'
        } else {
          throw 'HANDOFF_ROLLBACK_AGENT_CONFLICT'
        }
      }
    } catch {
      Write-Output 'KMJ_HANDOFF_ROLLBACK=FAILED_MANUAL_RECOVERY'
    }
  }
  throw 'KMJ_HANDOFF_FAILED'
}
