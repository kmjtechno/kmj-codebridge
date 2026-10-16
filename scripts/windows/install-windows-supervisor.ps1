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
function Write-Manifest([string]$Path, [object]$Value) {
  # Windows PowerShell 5.1's -Encoding UTF8 prepends EF BB BF. The
  # Node.js verifier uses JSON.parse on this file, which rejects a BOM.
  [System.IO.File]::WriteAllText(
    $Path,
    ($Value | ConvertTo-Json -Depth 8),
    ([System.Text.UTF8Encoding]::new($false))
  )
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
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$backup = Join-Path $BackupRoot $stamp

Write-Output "Mode           : $(if ($Apply) { 'APPLY' } else { 'DRY-RUN (no changes)' })"
Write-Output "Node           : $node (v$nodeMajor)"
Write-Output "Backup folder  : $backup"
Write-Output "Token file     : $tokenFile (created only if missing)"
Write-Output "Pipe           : $pipe"
Write-Output "Task (disabled): $TaskName as $ServiceAccount"
if (-not $Apply) { Write-Output 'Re-run with -Apply to make these changes. Nothing is started either way.'; return }

# Never replace a pre-existing task or proposed configuration. A backup alone
# is not a rollback guarantee for a Windows Scheduled Task.
if (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue) {
  throw "TASK_ALREADY_EXISTS: $TaskName; refusing to overwrite an existing task."
}
if (Test-Path -LiteralPath "$AgentConfig.proposed") {
  throw 'PROPOSED_AGENT_CONFIG_EXISTS: refusing to overwrite operator work.'
}

if (Test-Path -LiteralPath $tokenFile) { throw 'TOKEN_ALREADY_EXISTS: refusing to modify an existing token ACL.' }
if ($cfg.pipeName -notmatch '^kmj-codebridge-supervisor-[a-z0-9-]{1,40}$') { throw 'INVALID_PIPE_NAME' }
$json = Get-Content -LiteralPath $AgentConfig -Raw | ConvertFrom-Json
if (@($json.PSObject.Properties.Name) -contains 'supervisorSocket' -or
    @($json.PSObject.Properties.Name) -contains 'supervisorPipe' -or
    @($json.PSObject.Properties.Name) -contains 'supervisorTokenFile') {
  throw 'AGENT_SUPERVISOR_ALREADY_CONFIGURED'
}
if (Test-Path -LiteralPath $backup) { throw 'BACKUP_DESTINATION_EXISTS' }
New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
$manifest = [ordered]@{
  schema = 2
  createdUtc = $stamp
  taskName = $TaskName
  tokenFile = $tokenFile
  tokenCreatedByInstaller = $false
  tokenSha256 = $null
  proposedSha256 = $null
  taskExe = $null
  taskArgs = $null
  files = @()
}
foreach ($file in @($AgentConfig, $SupervisorConfig)) {
  $dest = Join-Path $backup ([System.IO.Path]::GetFileName($file))
  Copy-Item -LiteralPath $file -Destination $dest
  $manifest.files += [ordered]@{ source = $file; backup = $dest; sha256 = (Get-Sha256 $file) }
}
$manifestPath = Join-Path $backup 'manifest.json'
Write-Manifest $manifestPath $manifest

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
New-Item -ItemType Directory -Path (Split-Path -Parent $tokenFile) -Force | Out-Null
Set-Content -LiteralPath $tokenFile -Value $hex -NoNewline -Encoding ASCII
$manifest.tokenCreatedByInstaller = $true
$manifest.tokenSha256 = Get-Sha256 $tokenFile
Write-Manifest $manifestPath $manifest

# Restrict the secret: no inherited ACEs, only SYSTEM, Administrators and the service account.
& icacls.exe $tokenFile /inheritance:r /grant:r 'NT AUTHORITY\SYSTEM:(F)' 'BUILTIN\Administrators:(F)' "${ServiceAccount}:(R)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'icacls failed to restrict the token file.' }
$acl = (& icacls.exe $tokenFile) -join "`n"
if ($acl -match '(?i)\b(Everyone|Users|Authenticated Users|ANONYMOUS LOGON|INTERACTIVE|NETWORK)\b[^\n]*:') {
  throw 'Token file ACL still contains a broad principal; refusing to continue.'
}

$taskArgs = "`"$RuntimeDir\src\cli.js`" windows-supervisor `"$SupervisorConfig`""
$manifest.taskExe = $node
$manifest.taskArgs = $taskArgs
Write-Manifest $manifestPath $manifest
$action = New-ScheduledTaskAction -Execute $node -Argument $taskArgs -WorkingDirectory $RuntimeDir
$principal = New-ScheduledTaskPrincipal -UserId $ServiceAccount -LogonType S4U -RunLevel Limited
# A persistent agent must recover after reboot and transient failures. This
# task remains DISABLED after preparation; activation is a distinct step.
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1)) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' | Out-Null

$proposed = "$AgentConfig.proposed"
$json | Add-Member -NotePropertyName supervisorPipe -NotePropertyValue $pipe -Force
$json | Add-Member -NotePropertyName supervisorTokenFile -NotePropertyValue $tokenFile -Force
# Node's JSON.parse rejects UTF-8 BOM emitted by Windows PowerShell 5.1.
# Preserve the current agent.json and write only the proposed copy without BOM.
[System.IO.File]::WriteAllText(
  $proposed,
  ($json | ConvertTo-Json -Depth 32),
  ([System.Text.UTF8Encoding]::new($false))
)

$manifest.proposedSha256 = Get-Sha256 $proposed
Write-Manifest $manifestPath $manifest
Write-Output "Prepared. Task '$TaskName' is registered DISABLED and nothing was started."
Write-Output "Proposed agent config: $proposed (agent.json was not modified)."
Write-Output "Rollback: scripts\windows\rollback-windows-supervisor.ps1 -BackupDir `"$backup`" -TaskName $TaskName -Apply"
