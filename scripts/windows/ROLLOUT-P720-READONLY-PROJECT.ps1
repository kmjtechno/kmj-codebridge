<#
.SYNOPSIS
  Upgrade ONLY the running P720 Windows native supervisor to a pinned
  read-only CodeBridge project profile, preserving the active agent.
.DESCRIPTION
  Dry-run by default. -Apply clones a fresh verified SHA-pinned release,
  stages dependencies/config, backs up the active supervisor task and config,
  performs a guarded task cutover, then requires HMAC and read-only refusal.
  A failed cutover attempts the exact original task/config rollback.
#>
[CmdletBinding()]
param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Sha = '4828da1e3a82f8c2372f648836e985626d8681f6'
$OldSha = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$Root = 'D:\KMJ-HyperSpeed'
$ReleaseRoot = Join-Path $Root 'codebridge-releases'
$Release = Join-Path $ReleaseRoot $Sha
$OldRelease = Join-Path $ReleaseRoot $OldSha
$Private = Join-Path $Root 'private\p720-codebridge'
$BackupRoot = Join-Path $Root 'private\backups'
$Config = Join-Path $Private 'supervisor.json'
$Token = Join-Path $Private 'supervisor.token'
$Agent = Join-Path $Private 'agent.json'
$Project = Join-Path $Root 'projects\kmj-codebridge'
$TaskName = 'KMJ-CodeBridge-Supervisor'
$Verifier = Join-Path $PSScriptRoot 'verify-p720-readonly-rollout.mjs'
$OldVerifier = Join-Path $PSScriptRoot 'verify-p720-supervisor.mjs'
$TrustedOrigin = 'https://github.com/kmjtechno/kmj-codebridge.git'
$changedConfig = $false
$changedTask = $false
$oldAction = $null
$backupFile = $null
$originalHash = $null
$node = $null
$backupDir = $null

function Hash([string]$File) {
  return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Assert-File([string]$File) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf) -or
      ((Get-Item -LiteralPath $File).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'ROLLOUT_REQUIRED_FILE_UNTRUSTED'
  }
}
function Verify-OldHmac {
  & $node $OldVerifier $backupDir | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'ROLLOUT_OLD_HMAC_FAILED' }
}
function Check-Task {
  $t = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  if ($t.State -ne 'Running' -or @($t.Actions).Count -ne 1) {
    throw 'ROLLOUT_SUPERVISOR_TASK_NOT_RUNNING'
  }
  return $t
}
Write-Output 'KMJ_ROLLOUT_AGENT=UNTOUCHED'
Write-Output 'KMJ_ROLLOUT_CINECORE=UNTOUCHED'
Write-Output 'KMJ_ROLLOUT_DIRTY_CHECKOUT=UNTOUCHED'
try {
  if ($env:OS -ne 'Windows_NT') { throw 'ROLLOUT_WINDOWS_ONLY' }
  if ($Apply) {
    $who = [Security.Principal.WindowsIdentity]::GetCurrent()
    $admin = New-Object Security.Principal.WindowsPrincipal($who)
    if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'ROLLOUT_ADMIN_REQUIRED'
    }
  }
  foreach ($f in @($Config,$Token,$Agent,$Verifier,$OldVerifier,
                   (Join-Path $OldRelease 'src\cli.js'))) {
    Assert-File $f
  }
  foreach ($folder in @($Private,$BackupRoot,$ReleaseRoot,$Project)) {
    if (-not (Test-Path -LiteralPath $folder -PathType Container) -or
        ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'ROLLOUT_DIRECTORY_UNTRUSTED'
    }
  }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $git = (Get-Command git.exe -ErrorAction Stop).Source
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  if ((& $node --version) -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
    throw 'ROLLOUT_NODE24_REQUIRED'
  }
  $oldTask = Check-Task
  $oldAction = $oldTask.Actions[0]
  $manifestFiles = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $BackupRoot -File -Filter manifest.json -Recurse -ErrorAction Stop)) {
    try {
      $m = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
      if ($m.schema -eq 2 -and $m.taskName -ceq $TaskName) { $manifestFiles += $file }
    } catch {}
  }
  if ($manifestFiles.Count -ne 1) { throw 'ROLLOUT_MANIFEST_NOT_UNIQUE' }
  $backupDir = $manifestFiles[0].DirectoryName
  $m = Get-Content -LiteralPath $manifestFiles[0].FullName -Raw | ConvertFrom-Json
  if ($oldAction.Execute -cne [string]$m.taskExe -or
      $oldAction.Arguments -cne [string]$m.taskArgs -or
      $oldAction.WorkingDirectory -cne $OldRelease) {
    throw 'ROLLOUT_ORIGINAL_TASK_IDENTITY_CHANGED'
  }
  if ((Hash $Token) -cne [string]$m.tokenSha256) {
    throw 'ROLLOUT_TOKEN_CHANGED'
  }
  $supervisorBackups = @($m.files | Where-Object {
    [IO.Path]::GetFileName([string]$_.source) -ieq 'supervisor.json'
  })
  if ($supervisorBackups.Count -ne 1 -or
      (Hash $Config) -cne [string]$supervisorBackups[0].sha256) {
    throw 'ROLLOUT_SUPERVISOR_CONFIG_CHANGED'
  }
  $oldConfig = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  if ($oldConfig.pipeName -cne 'kmj-codebridge-supervisor-p720' -or
      [string]$oldConfig.tokenFile -ine $Token -or
      [string]$oldConfig.agent.configPath -ine $Agent -or
      [string]$oldConfig.agent.installDir -ine $OldRelease -or
      @($oldConfig.projects).Count -ne 0 -or
      @($oldConfig.PSObject.Properties.Name) -contains 'readOnlyProjects' -or
      @($oldConfig.agent.PSObject.Properties.Name) -contains 'restartTask') {
    throw 'ROLLOUT_ORIGINAL_CONFIG_NOT_APPROVED'
  }
  Verify-OldHmac
  $originalHash = Hash $Config
  Write-Output 'KMJ_ROLLOUT_PREFLIGHT=PASS'
  Write-Output 'KMJ_ROLLOUT_EXISTING_HMAC=PASS'
  if (-not $Apply) {
    Write-Output 'KMJ_ROLLOUT_MODE=READ_ONLY'
    return
  }
  if (Test-Path -LiteralPath $Release) {
    throw 'ROLLOUT_RELEASE_DIRECTORY_ALREADY_EXISTS'
  }
  & $git -c core.hooksPath=NUL clone --no-checkout --filter=blob:none $TrustedOrigin $Release
  if ($LASTEXITCODE -ne 0) { throw 'ROLLOUT_CLONE_FAILED' }
  & $git -C $Release -c core.hooksPath=NUL checkout --detach $Sha
  if ($LASTEXITCODE -ne 0) { throw 'ROLLOUT_CHECKOUT_FAILED' }
  $head = (& $git -C $Release rev-parse HEAD).Trim()
  $origin = (& $git -C $Release remote get-url origin).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -cne $Sha -or $origin -cne $TrustedOrigin) {
    throw 'ROLLOUT_PINNED_SOURCE_MISMATCH'
  }
  & $npm --prefix $Release ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'ROLLOUT_DEPENDENCIES_FAILED' }
  $candidate = "$Config.rollout-$Sha.candidate"
  if (Test-Path -LiteralPath $candidate) { throw 'ROLLOUT_CANDIDATE_ALREADY_EXISTS' }
  $oldConfig | Add-Member -NotePropertyName readOnlyProjects -NotePropertyValue @(
    [ordered]@{ id='kmj-codebridge'; repoRoot=$Project }
  )
  [IO.File]::WriteAllText($candidate,($oldConfig | ConvertTo-Json -Depth 20),
    ([Text.UTF8Encoding]::new($false)))
  & $node $Verifier stage $Release $candidate | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'ROLLOUT_CANDIDATE_INVALID' }
  Verify-OldHmac
  if ((Hash $Config) -cne $originalHash) {
    throw 'ROLLOUT_CONFIG_CHANGED_DURING_STAGING'
  }
  $before = Check-Task
  if ($before.Actions[0].Arguments -cne $oldAction.Arguments) {
    throw 'ROLLOUT_TASK_CHANGED_DURING_STAGING'
  }
  $replace = "$Config.rollout-$Sha.tmp"
  $backupFile = "$Config.rollout-$Sha.backup"
  if ((Test-Path -LiteralPath $replace) -or (Test-Path -LiteralPath $backupFile)) {
    throw 'ROLLOUT_BACKUP_COLLISION'
  }
  Copy-Item -LiteralPath $candidate -Destination $replace -ErrorAction Stop
  Set-Acl -LiteralPath $replace -AclObject (Get-Acl -LiteralPath $Config) -ErrorAction Stop
  [IO.File]::Replace($replace,$Config,$backupFile)
  $changedConfig = $true
  if ((Hash $backupFile) -cne $originalHash) {
    throw 'ROLLOUT_BACKUP_MISMATCH'
  }
  Write-Output 'KMJ_ROLLOUT_BACKUP=CREATED'
  $newArgs = ('"' + (Join-Path $Release 'src\cli.js') +
    '" windows-supervisor "' + $Config + '"')
  $newAction = New-ScheduledTaskAction -Execute $oldAction.Execute -Argument $newArgs -WorkingDirectory $Release
  Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  $changedTask = $true
  Set-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $newAction -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
  $live = $false
  for ($i = 0; $i -lt 18; $i++) {
    Start-Sleep -Seconds 1
    & $node $Verifier live $Release $Config --probe-quiet | Out-Null
    if ($LASTEXITCODE -eq 0) { $live = $true; break }
  }
  if (-not $live) {
    # The final explicit verification prints one truthful FAIL marker.
    # Earlier startup races are not reported as final failures.
    & $node $Verifier live $Release $Config | Out-Null
    throw 'ROLLOUT_HMAC_PROJECT_VERIFICATION_FAILED'
  }
  Write-Output 'KMJ_ROLLOUT_NEW_SUPERVISOR_HMAC=PASS'
  Write-Output 'KMJ_ROLLOUT_READONLY_PROJECT=PASS'
  Write-Output 'KMJ_ROLLOUT_AGENT=UNTOUCHED'
  Write-Output 'KMJ_ROLLOUT=PASS'
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{3,80}$') { $code = 'ROLLOUT_UNCLASSIFIED_FAILURE' }
  Write-Output "KMJ_ROLLOUT_BLOCKER=$code"
  if ($changedTask -or $changedConfig) {
    try {
      if ($changedTask) {
        Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
        Set-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $oldAction -ErrorAction Stop | Out-Null
      }
      if ($changedConfig) {
        if (-not $backupFile -or -not (Test-Path -LiteralPath $backupFile -PathType Leaf)) {
          throw 'ROLLOUT_CONFIG_BACKUP_MISSING'
        }
        $restore = "$Config.rollout-restore-$([guid]::NewGuid().ToString('N')).tmp"
        Copy-Item -LiteralPath $backupFile -Destination $restore -ErrorAction Stop
        Set-Acl -LiteralPath $restore -AclObject (Get-Acl -LiteralPath $Config) -ErrorAction Stop
        [IO.File]::Replace($restore,$Config,$null)
        if ((Hash $Config) -cne $originalHash) { throw 'ROLLOUT_RESTORE_HASH_MISMATCH' }
      }
      if ($changedTask) {
        Start-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
        $verified = $false
        for ($i = 0; $i -lt 15; $i++) {
          Start-Sleep -Seconds 1
          & $node $OldVerifier $backupDir | Out-Null
          if ($LASTEXITCODE -eq 0) { $verified=$true; break }
        }
        if (-not $verified) { throw 'ROLLOUT_ROLLBACK_HMAC_FAILED' }
      }
      Write-Output 'KMJ_ROLLOUT_ROLLBACK=PASS'
    } catch {
      Write-Output 'KMJ_ROLLOUT_ROLLBACK=FAILED_MANUAL_RECOVERY'
    }
  }
  throw 'KMJ_ROLLOUT_FAILED'
}
