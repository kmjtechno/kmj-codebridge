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

# Verify the backup is intact before changing anything.
foreach ($entry in $manifest.files) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.backup).Hash.ToLowerInvariant()
  if ($hash -ne $entry.sha256) { throw "Backup file changed or corrupt: $($entry.backup)" }
}
Write-Output "Mode: $(if ($Apply) { 'APPLY' } else { 'DRY-RUN (no changes)' }); backup verified ($($manifest.files.Count) files)."
if (-not $Apply) { Write-Output 'Re-run with -Apply to roll back.'; return }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Disable-ScheduledTask -TaskName $TaskName | Out-Null
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$supervisorBackup = $manifest.files | Where-Object { $_.source -like '*supervisor*.json' } | Select-Object -First 1
if ($manifest.tokenCreatedByInstaller -and $supervisorBackup) {
  $token = (Get-Content -LiteralPath $supervisorBackup.backup -Raw | ConvertFrom-Json).tokenFile
  if ($token -and (Test-Path -LiteralPath $token)) { Remove-Item -LiteralPath $token -Force }
}
$agentEntry = $manifest.files | Where-Object { $_.source -notlike 'task:*' -and $_.source -notlike '*supervisor*.json' } | Select-Object -First 1
if ($agentEntry) {
  $proposed = "$($agentEntry.source).proposed"
  if (Test-Path -LiteralPath $proposed) { Remove-Item -LiteralPath $proposed -Force }
}
if ($RestoreConfigs) {
  foreach ($entry in $manifest.files | Where-Object { $_.source -notlike 'task:*' }) {
    Copy-Item -LiteralPath $entry.backup -Destination $entry.source -Force
    $now = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.source).Hash.ToLowerInvariant()
    if ($now -ne $entry.sha256) { throw "Restore verification failed: $($entry.source)" }
  }
}
Write-Output 'Rollback complete. The agent configuration was not changed unless -RestoreConfigs was given.'
