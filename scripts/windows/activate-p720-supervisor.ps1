<#
.SYNOPSIS
  Safely activate an already prepared P720 supervisor and verify HMAC health.
.DESCRIPTION
  Dry run is the default. -Apply starts ONLY the exact prepared, disabled
  supervisor task after ownership, SHA and backup checks. The active agent,
  agent.json, CineCore and other tasks are not modified or restarted.
#>
[CmdletBinding()]
param(
  [string]$BackupRoot = 'D:\KMJ-HyperSpeed\private\backups',
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PinnedSha = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$TaskName = 'KMJ-CodeBridge-Supervisor'

if (-not [System.IO.Path]::IsPathRooted($BackupRoot)) { throw 'BACKUP_ROOT_NOT_ABSOLUTE' }
if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) { throw 'BACKUP_ROOT_MISSING' }
$manifests = @(Get-ChildItem -LiteralPath $BackupRoot -Filter manifest.json -Recurse -File -ErrorAction Stop)
$candidates = @()
foreach ($file in $manifests) {
  try {
    $candidate = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    if ($candidate.schema -eq 2 -and $candidate.taskName -ceq $TaskName) {
      $candidates += $file
    }
  } catch {
    # Ignore other products' malformed backup manifests.
  }
}
if ($candidates.Count -ne 1) {
  throw 'PREPARED_SUPERVISOR_MANIFEST_NOT_UNIQUE: zero or multiple candidate backups; no changes made'
}
$manifestFile = $candidates[0]
$manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json
if (-not $manifest.taskExe -or -not $manifest.taskArgs -or
    -not $manifest.tokenCreatedByInstaller -or -not $manifest.tokenSha256 -or
    -not $manifest.proposedSha256) {
  throw 'PREPARATION_INCOMPLETE'
}
$token = $manifest.tokenFile
if (-not [System.IO.Path]::IsPathRooted($token) -or
    -not (Test-Path -LiteralPath $token -PathType Leaf)) { throw 'TOKEN_MISSING' }
$actualTokenHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $token).Hash.ToLowerInvariant()
if ($actualTokenHash -cne $manifest.tokenSha256) { throw 'TOKEN_CHANGED' }
foreach ($entry in $manifest.files) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.backup).Hash.ToLowerInvariant()
  if ($actual -cne $entry.sha256) { throw 'BACKUP_HASH_MISMATCH' }
}
$agentEntry = @($manifest.files | Where-Object { [IO.Path]::GetFileName($_.source) -ieq 'agent.json' })
$supervisorEntry = @($manifest.files | Where-Object { [IO.Path]::GetFileName($_.source) -ieq 'supervisor.json' })
if ($agentEntry.Count -ne 1 -or $supervisorEntry.Count -ne 1) { throw 'CONFIG_MANIFEST_INVALID' }
$proposed = "$($agentEntry[0].source).proposed"
if ((-not (Test-Path -LiteralPath $proposed -PathType Leaf)) -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $proposed).Hash.ToLowerInvariant() -cne $manifest.proposedSha256) {
  throw 'AGENT_PROPOSAL_CHANGED'
}
$cfg = Get-Content -LiteralPath $supervisorEntry[0].backup -Raw | ConvertFrom-Json
$runtime = [string]$cfg.agent.installDir
if ([IO.Path]::GetFileName($runtime.TrimEnd('\')) -cne $PinnedSha -or
    -not (Test-Path -LiteralPath (Join-Path $runtime 'src\supervisor-client.js') -PathType Leaf)) {
  throw 'RUNTIME_IDENTITY_INVALID'
}
$git = (Get-Command git.exe -ErrorAction Stop).Source
$actualSha = (& $git -C $runtime rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualSha -cne $PinnedSha) { throw 'RUNTIME_SHA_MISMATCH' }
$origin = (& $git -C $runtime remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -cne 'https://github.com/kmjtechno/kmj-codebridge.git') {
  throw 'RUNTIME_ORIGIN_MISMATCH'
}
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
if (@($task.Actions).Count -ne 1 -or
    $task.Actions[0].Execute -cne $manifest.taskExe -or
    $task.Actions[0].Arguments -cne $manifest.taskArgs -or
    $task.Actions[0].WorkingDirectory -cne $runtime) {
  throw 'TASK_IDENTITY_MISMATCH'
}
if ($task.State -ne 'Disabled') {
  throw 'TASK_NOT_IN_PREPARED_DISABLED_STATE'
}
if (@($task.Triggers).Count -lt 1) { throw 'TASK_HAS_NO_STARTUP_TRIGGER' }
Write-Output 'BACKUP=VERIFIED'
Write-Output 'RUNTIME_SHA=VERIFIED'
Write-Output 'TASK_IDENTITY=VERIFIED'
Write-Output 'AGENT_CONFIG=UNTOUCHED'
Write-Output 'CINECORE=UNTOUCHED'
if (-not $Apply) {
  Write-Output 'MODE=DRY_RUN'
  return
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'ADMINISTRATOR_REQUIRED'
}
$node = [string]$manifest.taskExe
$verifier = Join-Path $PSScriptRoot 'verify-p720-supervisor.mjs'
if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) { throw 'HMAC_VERIFIER_MISSING' }
$enabled = $false
try {
  Enable-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop | Out-Null
  $enabled = $true
  Start-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  $verified = $false
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    & $node $verifier $manifestFile.DirectoryName | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $verified = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $verified) { throw 'SUPERVISOR_HMAC_VERIFICATION_FAILED' }
  Write-Output 'SUPERVISOR_ACTIVATION=PASS'
  Write-Output 'AGENT_HANDOFF=PENDING_SEPARATE_VERIFIED_STEP'
} catch {
  if ($enabled) {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue | Out-Null
  }
  throw 'SUPERVISOR_ACTIVATION_ROLLED_BACK'
}
