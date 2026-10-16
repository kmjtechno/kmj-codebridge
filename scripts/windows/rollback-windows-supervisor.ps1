<#
.SYNOPSIS
  Rolls back what install-windows-supervisor.ps1 prepared. Dry-run by default.

.DESCRIPTION
  With -Apply it disables and unregisters the supervisor task, removes the token
  file only if the installer created it, and deletes agent.json.proposed. It
  restores the backed-up configs only when -RestoreConfigs is also given, and
  verifies every restored file against the SHA-256 recorded in manifest.json.
  It never touches project checkouts, the CineCore worktrees or any other task.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BackupDir,
  [string]$TaskName = 'KMJ-CodeBridge-Supervisor',
  [switch]$RestoreConfigs,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not [System.IO.Path]::IsPathRooted($BackupDir) -or $BackupDir -match '\.\.') { throw 'BackupDir must be absolute.' }
if ($TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw 'Invalid TaskName.' }
$manifestPath = Join-Path $BackupDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'manifest.json not found in BackupDir.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 2 -or $manifest.taskName -cne $TaskName) {
  throw 'ROLLBACK_MANIFEST_TASK_MISMATCH'
}
if (-not [System.IO.Path]::IsPathRooted($manifest.tokenFile)) {
  throw 'ROLLBACK_TOKEN_PATH_INVALID'
}

# Verify the backup is intact before changing anything.
foreach ($entry in $manifest.files) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.backup).Hash.ToLowerInvariant()
  if ($hash -ne $entry.sha256) { throw "Backup file changed or corrupt: $($entry.backup)" }
}
# Check ALL targets before changing anything, even when a partial install failed.
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task) {
  if (-not $manifest.taskExe -or -not $manifest.taskArgs -or
      @($task.Actions).Count -ne 1 -or
      $task.Actions[0].Execute -cne $manifest.taskExe -or
      $task.Actions[0].Arguments -cne $manifest.taskArgs) {
    throw 'ROLLBACK_TASK_IDENTITY_MISMATCH'
  }
}
if ($manifest.tokenCreatedByInstaller -and (Test-Path -LiteralPath $manifest.tokenFile)) {
  if (-not $manifest.tokenSha256 -or
      (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest.tokenFile).Hash.ToLowerInvariant() -ne $manifest.tokenSha256) {
    throw 'ROLLBACK_TOKEN_CHANGED: refusing to delete a replaced token.'
  }
}
$agentEntry = $manifest.files | Where-Object { $_.source -notlike 'task:*' -and $_.source -notlike '*supervisor*.json' } | Select-Object -First 1
if ($agentEntry) {
  $proposed = "$($agentEntry.source).proposed"
  if ((Test-Path -LiteralPath $proposed) -and
      (-not $manifest.proposedSha256 -or
       (Get-FileHash -Algorithm SHA256 -LiteralPath $proposed).Hash.ToLowerInvariant() -ne $manifest.proposedSha256)) {
    throw 'ROLLBACK_PROPOSED_CONFIG_CHANGED: refusing to erase operator changes.'
  }
}
# Install never changes agent.json or supervisor.json in place.
# Even an explicit restore must refuse to overwrite a newer operator edit.
if ($RestoreConfigs) {
  foreach ($entry in $manifest.files | Where-Object { $_.source -notlike 'task:*' }) {
    if (-not (Test-Path -LiteralPath $entry.source -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.source).Hash.ToLowerInvariant() -cne $entry.sha256) {
      throw 'RESTORE_TARGET_CHANGED: refusing to overwrite existing configuration.'
    }
  }
}
Write-Output "Mode: $(if ($Apply) { 'APPLY' } else { 'DRY-RUN (no changes)' }); backup verified ($($manifest.files.Count) files)."
if (-not $Apply) { Write-Output 'Re-run with -Apply to roll back.'; return }


if ($task) {
  Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' | Out-Null
  Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
}
if ($manifest.tokenCreatedByInstaller -and (Test-Path -LiteralPath $manifest.tokenFile)) {
  Remove-Item -LiteralPath $manifest.tokenFile -Force
}
if ($agentEntry -and (Test-Path -LiteralPath $proposed)) {
  Remove-Item -LiteralPath $proposed -Force
}
if ($RestoreConfigs) {
  foreach ($entry in $manifest.files | Where-Object { $_.source -notlike 'task:*' }) {
    Copy-Item -LiteralPath $entry.backup -Destination $entry.source -Force
    $now = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.source).Hash.ToLowerInvariant()
    if ($now -ne $entry.sha256) { throw "Restore verification failed: $($entry.source)" }
  }
}
Write-Output 'Rollback complete. The agent configuration was not changed unless -RestoreConfigs was given.'
