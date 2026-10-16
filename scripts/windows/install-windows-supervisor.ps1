<#
.SYNOPSIS
  Prepares (does NOT activate) the CodeBridge Windows-native supervisor.

.DESCRIPTION
  Dry-run by default. With -Apply it:
    1. backs up the agent config, the supervisor config and the task definition
       into a timestamped folder with SHA-256 hashes;
    2. creates the supervisor secret file (only if missing) and restricts its ACL
       to SYSTEM, Administrators and the service account;
    3. registers a DISABLED scheduled task for the supervisor;
    4. writes agent.json.proposed next to the agent config. agent.json itself is
       never modified, and nothing is started.
  Activation is a separate, manual step (see docs/WINDOWS-SUPERVISOR.md).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SupervisorConfig,
  [Parameter(Mandatory)][string]$AgentConfig,
  [Parameter(Mandatory)][string]$RuntimeDir,
  [Parameter(Mandatory)][string]$BackupRoot,
  [Parameter(Mandatory)][string]$ServiceAccount,
  [string]$TaskName = 'KMJ-CodeBridge-Supervisor',
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Absolute([string]$Path, [string]$Name) {
  if (-not [System.IO.Path]::IsPathRooted($Path) -or $Path -match '\.\.') {
    throw "$Name must be an absolute path without '..'."
  }
}
function Get-Sha256([string]$Path) {
  (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

foreach ($pair in @(
    @($SupervisorConfig, 'SupervisorConfig'), @($AgentConfig, 'AgentConfig'),
    @($RuntimeDir, 'RuntimeDir'), @($BackupRoot, 'BackupRoot'))) {
  Assert-Absolute $pair[0] $pair[1]
}
if ($TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw 'Invalid TaskName.' }
if ($ServiceAccount -notmatch '^[A-Za-z0-9_.\\-]{1,64}$') { throw 'Invalid ServiceAccount.' }
foreach ($required in @($SupervisorConfig, $AgentConfig, (Join-Path $RuntimeDir 'src\cli.js'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing required file: $required" }
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeMajor = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw "Node 24 or newer is required; found $nodeMajor." }

$cfg = Get-Content -LiteralPath $SupervisorConfig -Raw | ConvertFrom-Json
$tokenFile = $cfg.tokenFile
Assert-Absolute $tokenFile 'tokenFile'
$pipe = "\\.\pipe\$($cfg.pipeName)"
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$backup = Join-Path $BackupRoot $stamp

Write-Output "Mode           : $(if ($Apply) { 'APPLY' } else { 'DRY-RUN (no changes)' })"
Write-Output "Node           : $node (v$nodeMajor)"
Write-Output "Backup folder  : $backup"
Write-Output "Token file     : $tokenFile (created only if missing)"
Write-Output "Pipe           : $pipe"
Write-Output "Task (disabled): $TaskName as $ServiceAccount"
if (-not $Apply) { Write-Output 'Re-run with -Apply to make these changes. Nothing is started either way.'; return }

New-Item -ItemType Directory -Path $backup -Force | Out-Null
$manifest = [ordered]@{ schema = 1; createdUtc = $stamp; tokenCreatedByInstaller = $false; files = @() }
foreach ($file in @($AgentConfig, $SupervisorConfig)) {
  $dest = Join-Path $backup ([System.IO.Path]::GetFileName($file))
  Copy-Item -LiteralPath $file -Destination $dest
  $manifest.files += [ordered]@{ source = $file; backup = $dest; sha256 = (Get-Sha256 $file) }
}
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  $xml = Join-Path $backup "$TaskName.task.xml"
  Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $xml -Encoding UTF8
  $manifest.files += [ordered]@{ source = "task:$TaskName"; backup = $xml; sha256 = (Get-Sha256 $xml) }
}

if (-not (Test-Path -LiteralPath $tokenFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  New-Item -ItemType Directory -Path (Split-Path -Parent $tokenFile) -Force | Out-Null
  Set-Content -LiteralPath $tokenFile -Value $hex -NoNewline -Encoding ASCII
  $manifest.tokenCreatedByInstaller = $true
}
# Restrict the secret: no inherited ACEs, only SYSTEM, Administrators and the service account.
& icacls.exe $tokenFile /inheritance:r /grant:r 'NT AUTHORITY\SYSTEM:(F)' 'BUILTIN\Administrators:(F)' "${ServiceAccount}:(R)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'icacls failed to restrict the token file.' }
$acl = (& icacls.exe $tokenFile) -join "`n"
if ($acl -match '(?i)\b(Everyone|Users|Authenticated Users|ANONYMOUS LOGON|INTERACTIVE|NETWORK)\b[^\n]*:') {
  throw 'Token file ACL still contains a broad principal; refusing to continue.'
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$RuntimeDir\src\cli.js`" windows-supervisor `"$SupervisorConfig`"" -WorkingDirectory $RuntimeDir
$principal = New-ScheduledTaskPrincipal -UserId $ServiceAccount -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Disable-ScheduledTask -TaskName $TaskName | Out-Null

$proposed = "$AgentConfig.proposed"
$json = Get-Content -LiteralPath $AgentConfig -Raw | ConvertFrom-Json
$json | Add-Member -NotePropertyName supervisorPipe -NotePropertyValue $pipe -Force
$json | Add-Member -NotePropertyName supervisorTokenFile -NotePropertyValue $tokenFile -Force
$json | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $proposed -Encoding UTF8

$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $backup 'manifest.json') -Encoding UTF8
Write-Output "Prepared. Task '$TaskName' is registered DISABLED and nothing was started."
Write-Output "Proposed agent config: $proposed (agent.json was not modified)."
Write-Output "Rollback: scripts\windows\rollback-windows-supervisor.ps1 -BackupDir `"$backup`" -TaskName $TaskName -Apply"
