<#
.SYNOPSIS
  One-time isolated P720 CodeBridge Windows supervisor preparation.
.DESCRIPTION
  Dry-run by default. -Apply stages a Git SHA-pinned release in a NEW directory,
  installs production npm dependencies without lifecycle scripts, writes only a
  NEW supervisor config, and invokes the hardened installer to register a
  DISABLED auto-start task. It does NOT modify or restart the active agent,
  enable/start a task, or touch a dirty checkout. No credentials are displayed.
#>
[CmdletBinding()]
param(
  [string]$AgentConfig = 'D:\KMJ-HyperSpeed\private\p720-codebridge\agent.json',
  [string]$ReleaseRoot = 'D:\KMJ-HyperSpeed\codebridge-releases',
  [string]$PrivateRoot = 'D:\KMJ-HyperSpeed\private',
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Exact green + merged PR #462 runtime, not a mutable main/HEAD checkout.
$ExpectedSha = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$TrustedOrigin = 'https://github.com/kmjtechno/kmj-codebridge.git'
$ReleaseDir = Join-Path $ReleaseRoot $ExpectedSha
$SupervisorConfig = Join-Path (Join-Path $PrivateRoot 'p720-codebridge') 'supervisor.json'
$TokenFile = Join-Path (Join-Path $PrivateRoot 'p720-codebridge') 'supervisor.token'
$BackupRoot = Join-Path $PrivateRoot 'backups'
$Installer = Join-Path $PSScriptRoot 'install-windows-supervisor.ps1'

function Assert-DrivePath([string]$Value, [string]$Name) {
  if ($Value -notmatch '^[A-Za-z]:\\' -or $Value.Substring(2) -match '[<>:"|?*]' -or
      @($Value -split '\\') -contains '..') {
    throw "INVALID_DRIVE_PATH: $Name"
  }
}
foreach ($entry in @(
    @($AgentConfig, 'AgentConfig'), @($ReleaseRoot, 'ReleaseRoot'),
    @($PrivateRoot, 'PrivateRoot'))) {
  Assert-DrivePath $entry[0] $entry[1]
}
if (-not (Test-Path -LiteralPath $AgentConfig -PathType Leaf)) {
  throw 'P720_AGENT_CONFIG_MISSING'
}
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
  throw 'TRUSTED_SUPERVISOR_INSTALLER_MISSING'
}
if (Test-Path -LiteralPath $SupervisorConfig) {
  throw 'EXISTING_SUPERVISOR_CONFIG_REFUSED'
}
if (Test-Path -LiteralPath $TokenFile) {
  throw 'EXISTING_SUPERVISOR_TOKEN_REFUSED'
}
if (Test-Path -LiteralPath "$AgentConfig.proposed") {
  throw 'EXISTING_AGENT_PROPOSAL_REFUSED'
}
$agent = Get-Content -LiteralPath $AgentConfig -Raw | ConvertFrom-Json
if ($agent.PSObject.Properties.Name -contains 'supervisorPipe' -or
    $agent.PSObject.Properties.Name -contains 'supervisorTokenFile' -or
    $agent.PSObject.Properties.Name -contains 'supervisorSocket') {
  throw 'P720_AGENT_ALREADY_HAS_SUPERVISOR'
}
$matching = @($agent.projects | Where-Object { $_.id -eq 'kmj-codebridge' })
if ($matching.Count -ne 1) { throw 'P720_AGENT_PROJECT_SCOPE_MISMATCH' }
$git = (Get-Command git.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $node --version).TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 24) { throw 'NODE_24_REQUIRED' }
if (Test-Path -LiteralPath $ReleaseDir) {
  throw 'PINNED_RELEASE_DIRECTORY_ALREADY_EXISTS: refusing to overwrite'
}
Write-Output "MODE=$(if ($Apply) { 'PREPARE_DISABLED' } else { 'DRY_RUN' })"
Write-Output "PINNED_RUNTIME_SHA=$ExpectedSha"
Write-Output 'DIRTY_CHECKOUT=UNTOUCHED'
Write-Output 'ACTIVE_AGENT=UNTOUCHED'
Write-Output 'CINECORE_AGENT=UNTOUCHED'
Write-Output 'SUPERVISOR_START=NO'
Write-Output 'ROLLBACK=INSTALLER_MANIFEST'
if (-not $Apply) { return }

# New install root only. Never execute Git commands within a live source checkout.
New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null
& $git -c core.hooksPath=NUL clone --no-checkout --filter=blob:none $TrustedOrigin $ReleaseDir
if ($LASTEXITCODE -ne 0) { throw 'PINNED_CLONE_FAILED' }
& $git -C $ReleaseDir -c core.hooksPath=NUL checkout --detach $ExpectedSha
if ($LASTEXITCODE -ne 0) { throw 'PINNED_CHECKOUT_FAILED' }
$actual = (& $git -C $ReleaseDir rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -cne $ExpectedSha) {
  throw 'PINNED_SHA_MISMATCH'
}
$origin = (& $git -C $ReleaseDir remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -cne $TrustedOrigin) {
  throw 'UNTRUSTED_RUNTIME_ORIGIN'
}
& $npm --prefix $ReleaseDir ci --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'PINNED_RUNTIME_DEPENDENCIES_FAILED' }

# Deliberately omits caller-selected restart task or project executables.
$config = [ordered]@{
  pipeName = 'kmj-codebridge-supervisor-p720'
  tokenFile = $TokenFile
  agent = [ordered]@{
    installDir = $ReleaseDir
    configPath = $AgentConfig
  }
  projects = @()
}
New-Item -ItemType Directory -Path (Split-Path -Parent $SupervisorConfig) -Force | Out-Null
$config | ConvertTo-Json -Depth 8 |
  Set-Content -LiteralPath $SupervisorConfig -Encoding UTF8 -NoNewline
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& $Installer -SupervisorConfig $SupervisorConfig -AgentConfig $AgentConfig -RuntimeDir $ReleaseDir -BackupRoot $BackupRoot -ServiceAccount $account -Apply
if (-not $?) { throw 'SUPERVISOR_PREPARATION_FAILED' }
Write-Output 'PREPARATION_COMPLETE=DISABLED_NOT_ACTIVATED'
Write-Output 'NEXT=Review manifest and activate task, then reconnect agent.'
