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
  [switch]$Apply,
  [switch]$Resume
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
  if (-not $Resume) {
    throw 'PINNED_RELEASE_DIRECTORY_ALREADY_EXISTS: use the guarded recovery launcher; refusing to overwrite'
  }
} elseif ($Resume) {
  throw 'PINNED_RELEASE_MISSING: cannot resume an absent release'
}
Write-Output "MODE=$(if ($Apply) { 'PREPARE_DISABLED' } else { 'DRY_RUN' })"
Write-Output "PINNED_RUNTIME_SHA=$ExpectedSha"
Write-Output 'DIRTY_CHECKOUT=UNTOUCHED'
Write-Output 'ACTIVE_AGENT=UNTOUCHED'
Write-Output 'CINECORE_AGENT=UNTOUCHED'
Write-Output 'SUPERVISOR_START=NO'
Write-Output 'ROLLBACK=INSTALLER_MANIFEST'
Write-Output "STAGING_MODE=$(if ($Resume) { 'VERIFY_EXISTING_SHA' } else { 'CLONE_NEW_SHA' })"
if (-not $Apply) { return }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'ADMINISTRATOR_REQUIRED: right-click the trusted CMD launcher and choose Run as administrator'
}

# Never execute git operations in the live dirty development checkout.
if ($Resume) {
  # Read-only verification. No checkout/reset/fetch/clean in an existing tree.
  if (-not (Test-Path -LiteralPath (Join-Path $ReleaseDir '.git'))) {
    throw 'RESUME_NOT_A_GIT_CHECKOUT'
  }
  $inFlight = @(Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object {
      $_.CommandLine -and
      (
        ($_.Name -in @('git.exe','node.exe','npm.cmd','cmd.exe') -and
          $_.CommandLine.IndexOf($ReleaseDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
        ($_.Name -in @('powershell.exe','pwsh.exe') -and
          $_.CommandLine -match '(?i)(ONE-CLICK-P720-SUPERVISOR|bootstrap-p720-supervisor)\.ps1')
      )
    })
  if ($inFlight.Count -gt 0) {
    throw 'RESUME_ORIGINAL_INSTALLER_PROCESS_STILL_ACTIVE'
  }
  # clone --no-checkout can finish cleanly before its separate pinned checkout.
  # Only an empty clone (exactly .git, no indexed files) may advance that stage.
  $headBefore = (& $git -C $ReleaseDir rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'RESUME_HEAD_UNREADABLE' }
  if ($headBefore -cne $ExpectedSha) {
    $otherFiles = @(Get-ChildItem -LiteralPath $ReleaseDir -Force -ErrorAction Stop |
      Where-Object { $_.Name -cne '.git' })
    $indexedFiles = @(& $git -C $ReleaseDir ls-files)
    if ($LASTEXITCODE -ne 0 -or $otherFiles.Count -ne 0 -or $indexedFiles.Count -ne 0) {
      throw 'RESUME_CHECKOUT_IS_NOT_EMPTY: no checkout is permitted'
    }
    $commitObject = "$ExpectedSha" + '^{commit}'
    & $git -C $ReleaseDir cat-file -e $commitObject
    if ($LASTEXITCODE -ne 0) { throw 'RESUME_EXPECTED_COMMIT_MISSING' }
    Write-Output 'STAGE=RESUME_PINNED_CHECKOUT_FROM_EMPTY_CLONE'
    & $git -C $ReleaseDir -c core.hooksPath=NUL checkout --detach $ExpectedSha
    if ($LASTEXITCODE -ne 0) { throw 'RESUME_PINNED_CHECKOUT_FAILED' }
  }
  Write-Output 'RESUME=CHECK_EXISTING_IMMUTABLE_RELEASE'
} else {
  New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null
  Write-Output 'STAGE=GIT_CLONE'
  & $git -c core.hooksPath=NUL clone --no-checkout --filter=blob:none $TrustedOrigin $ReleaseDir
  if ($LASTEXITCODE -ne 0) { throw 'PINNED_CLONE_FAILED' }
  Write-Output 'STAGE=GIT_CHECKOUT'
  & $git -C $ReleaseDir -c core.hooksPath=NUL checkout --detach $ExpectedSha
  if ($LASTEXITCODE -ne 0) { throw 'PINNED_CHECKOUT_FAILED' }
}
$actual = (& $git -C $ReleaseDir rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -cne $ExpectedSha) {
  throw 'PINNED_SHA_MISMATCH'
}
$origin = (& $git -C $ReleaseDir remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -cne $TrustedOrigin) {
  throw 'UNTRUSTED_RUNTIME_ORIGIN'
}
if ($Resume) {
  $changes = @(& $git -C $ReleaseDir status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $changes.Count -gt 0) {
    throw 'RESUME_RELEASE_NOT_CLEAN: no existing file can be overwritten'
  }
}
Write-Output 'STAGE=INSTALL_DEPENDENCIES_ISOLATED'
& $npm --prefix $ReleaseDir ci --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'PINNED_RUNTIME_DEPENDENCIES_FAILED' }

# Deliberately omits caller-selected restart task or project executables.
Write-Output 'STAGE=PREPARE_CONFIG_ONLY'
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
# Windows PowerShell 5.1 Set-Content -Encoding UTF8 adds a BOM; Node JSON.parse
# rejects that prefix. Write UTF-8 without BOM for all Node-readable JSON.
[System.IO.File]::WriteAllText(
  $SupervisorConfig,
  ($config | ConvertTo-Json -Depth 8),
  ([System.Text.UTF8Encoding]::new($false))
)
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Output 'STAGE=REGISTER_DISABLED_SUPERVISOR'
& $Installer -SupervisorConfig $SupervisorConfig -AgentConfig $AgentConfig -RuntimeDir $ReleaseDir -BackupRoot $BackupRoot -ServiceAccount $account -Apply
if (-not $?) { throw 'SUPERVISOR_PREPARATION_FAILED' }
Write-Output 'PREPARATION_COMPLETE=DISABLED_NOT_ACTIVATED'
Write-Output 'NEXT=Review manifest and activate task, then reconnect agent.'
