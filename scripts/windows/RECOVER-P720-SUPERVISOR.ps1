<#
.SYNOPSIS
  Diagnose and safely recover the operator's interrupted P720 supervisor setup.
.DESCRIPTION
  No writes by default. -Apply only advances one verified installation state:
  (1) initial absent release, (2) existing SHA-pinned clean release, (3) empty
  Git --no-checkout clone, (4) one intact disabled supervisor task.
  Never removes, resets or force-replaces any existing release, token, agent
  enrollment, supervisor config, task or backup. Never touches CineCore.
#>
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Sha = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$ReleaseDir = Join-Path 'D:\KMJ-HyperSpeed\codebridge-releases' $Sha
$Private = 'D:\KMJ-HyperSpeed\private\p720-codebridge'
$BackupRoot = 'D:\KMJ-HyperSpeed\private\backups'
$TaskName = 'KMJ-CodeBridge-Supervisor'
$bootstrap = Join-Path $PSScriptRoot 'bootstrap-p720-supervisor.ps1'
$activation = Join-Path $PSScriptRoot 'activate-p720-supervisor.ps1'
$verifier = Join-Path $PSScriptRoot 'verify-p720-supervisor.mjs'
$agentConfig = Join-Path $Private 'agent.json'
$supervisorConfig = Join-Path $Private 'supervisor.json'
$token = Join-Path $Private 'supervisor.token'
$proposed = "$agentConfig.proposed"

foreach ($script in @($bootstrap, $activation, $verifier)) {
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw 'RECOVERY_TRUSTED_SCRIPT_MISSING'
  }
}
if (-not (Test-Path -LiteralPath $agentConfig -PathType Leaf)) {
  throw 'RECOVERY_EXISTING_AGENT_CONFIG_MISSING'
}
if ($Apply) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'RECOVERY_ADMINISTRATOR_REQUIRED'
  }
}

Write-Output "KMJ_RECOVERY_MODE=$(if ($Apply) { 'GUARDED_APPLY' } else { 'READ_ONLY' })"
Write-Output 'ACTIVE_AGENT=UNTOUCHED'
Write-Output 'CINECORE_AGENT=UNTOUCHED'
Write-Output 'DIRTY_CHECKOUT=UNTOUCHED'

# If the original one-click installer is still running, never race it.
# Look only at process command lines locally; never print them or pass them
# into another process. A failed inventory aborts instead of guessing.
$running = @(Get-CimInstance Win32_Process -ErrorAction Stop |
  Where-Object {
    # The new one-click entrypoint calls this script in the SAME
    # PowerShell process. Never classify our own $PID as a second installer.
    $_.ProcessId -ne $PID -and
    $_.CommandLine -and
    (
      ($_.Name -in @('git.exe','node.exe','npm.cmd','cmd.exe') -and
        $_.CommandLine.IndexOf($ReleaseDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
      ($_.Name -in @('powershell.exe','pwsh.exe') -and
        $_.CommandLine -match '(?i)(ONE-CLICK-P720-SUPERVISOR|bootstrap-p720-supervisor)\.ps1')
    )
  })
if ($running.Count -gt 0) {
  # Only print process type and IDs; never CommandLine or secrets.
  Write-Output "KMJ_RECOVERY_BLOCKING_PROCESS_COUNT=$($running.Count)"
  foreach ($proc in @($running | Sort-Object ProcessId | Select-Object -First 12)) {
    $kind = 'OTHER_PROCESS'
    if ($proc.Name -in @('powershell.exe','pwsh.exe')) {
      $kind = 'INSTALLER_HOST'
    } elseif ($proc.Name -eq 'git.exe') {
      $kind = 'GIT_STAGE'
    } elseif ($proc.Name -eq 'node.exe') {
      $kind = 'NODE_PROCESS'
    } elseif ($proc.Name -in @('cmd.exe','npm.cmd')) {
      $kind = 'SHELL_OR_DEPENDENCY_PROCESS'
    }
    Write-Output "KMJ_RECOVERY_BLOCKING_PROCESS=$kind;PID=$($proc.ProcessId);PPID=$($proc.ParentProcessId)"
  }
  Write-Output 'KMJ_RECOVERY_STATE=EXISTING_INSTALLER_STILL_RUNNING'
  Write-Output 'KMJ_RECOVERY_ACTION=DO_NOT_START_SECOND_INSTALLER'
  if ($Apply) {
    throw 'RECOVERY_ORIGINAL_INSTALLER_STILL_RUNNING'
  }
  return
}

$backups = @()
if (Test-Path -LiteralPath $BackupRoot -PathType Container) {
  foreach ($file in @(Get-ChildItem -LiteralPath $BackupRoot -Filter manifest.json -File -Recurse -ErrorAction Stop)) {
    try {
      $m = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($m.schema -eq 2 -and $m.taskName -ceq $TaskName) { $backups += $file }
    } catch {
      # Foreign or malformed backups are never silently modified.
    }
  }
}
if ($backups.Count -gt 1) {
  throw 'RECOVERY_AMBIGUOUS_BACKUPS: no task or file changed'
}
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task) {
  if ($backups.Count -ne 1) {
    throw 'RECOVERY_TASK_WITHOUT_UNIQUE_BACKUP'
  }
  if ($task.State -eq 'Disabled') {
    Write-Output 'KMJ_RECOVERY_STATE=PREPARED_DISABLED'
    Write-Output 'KMJ_RECOVERY_ACTION=GUARDED_HMAC_ACTIVATION'
    if (-not $Apply) { return }
    & $activation -Apply
    if (-not $?) { throw 'RECOVERY_ACTIVATION_FAILED' }
    Write-Output 'KMJ_RECOVERY_SUPERVISOR=VERIFIED'
    Write-Output 'KMJ_RECOVERY_AGENT_HANDOFF=PENDING'
    return
  }
  if ($task.State -in @('Ready', 'Running')) {
    Write-Output 'KMJ_RECOVERY_STATE=SUPERVISOR_TASK_ENABLED'
    Write-Output 'KMJ_RECOVERY_ACTION=HMAC_HEALTH_CHECK_ONLY'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    & $node $verifier $backups[0].DirectoryName
    if ($LASTEXITCODE -ne 0) { throw 'RECOVERY_ENABLED_TASK_HMAC_FAILED' }
    Write-Output 'KMJ_RECOVERY_SUPERVISOR=VERIFIED'
    Write-Output 'KMJ_RECOVERY_AGENT_HANDOFF=PENDING'
    return
  }
  throw 'RECOVERY_TASK_UNEXPECTED_STATE'
}
# Do not reuse partial install state. There is only one safe automatic
# resumption path when the task has not yet been registered.
if ($backups.Count -ne 0 -or
    (Test-Path -LiteralPath $supervisorConfig) -or
    (Test-Path -LiteralPath $token) -or
    (Test-Path -LiteralPath $proposed)) {
  throw 'RECOVERY_PARTIAL_REGISTRATION: preserve files for guarded review'
}
if (Test-Path -LiteralPath $ReleaseDir -PathType Container) {
  if (-not (Test-Path -LiteralPath (Join-Path $ReleaseDir '.git'))) {
    throw 'RECOVERY_EXISTING_RELEASE_NOT_GIT'
  }
  Write-Output 'KMJ_RECOVERY_STATE=ISOLATED_RELEASE_PRESENT'
  Write-Output 'KMJ_RECOVERY_ACTION=VERIFY_AND_RESUME_EXISTING_RELEASE'
  if (-not $Apply) { return }
  & $bootstrap -Resume -Apply
} else {
  Write-Output 'KMJ_RECOVERY_STATE=RELEASE_ABSENT'
  Write-Output 'KMJ_RECOVERY_ACTION=PREPARE_NEW_RELEASE'
  if (-not $Apply) { return }
  & $bootstrap -Apply
}
if (-not $?) { throw 'RECOVERY_PREPARATION_FAILED' }
Write-Output 'KMJ_RECOVERY_STATE=PREPARED_DISABLED'
& $activation -Apply
if (-not $?) { throw 'RECOVERY_ACTIVATION_FAILED' }
Write-Output 'KMJ_RECOVERY_SUPERVISOR=VERIFIED'
Write-Output 'KMJ_RECOVERY_AGENT_HANDOFF=PENDING'
