# P520-only guarded Supervisor DISABLED task preparation.
# Dry-run by default. Never installs/starts the AI server or restarts agents.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$AgentConfig,
  [Parameter(Mandatory)][string]$SupervisorConfig,
  [Parameter(Mandatory)][string]$RuntimeDir,
  [Parameter(Mandatory)][string]$BackupRoot,
  [Parameter(Mandatory)][string]$ServiceAccount,
  [Parameter(Mandatory)][string]$AgentConfigSha256,
  [Parameter(Mandatory)][string]$SupervisorConfigSha256,
  [Parameter(Mandatory)][string]$RuntimeEntrySha256,
  [Parameter(Mandatory)][string]$NodeExeSha256,
  [Parameter(Mandatory)][string]$GitExeSha256,
  [Parameter(Mandatory)][string]$ExpectedRuntimeGitSha,
  [Parameter(Mandatory)][string]$InstallerSha256,
  [switch]$Apply,
  [switch]$ConfirmDisabledPreparation
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$taskName='KMJ-CodeBridge-Supervisor-P520'
$pipeName='kmj-codebridge-supervisor-p520'
$expectedDevice='kmj-kmj-codebridge-desktop-5fvjmet'
function Mark([string]$key,[string]$value) { Write-Output ($key+'='+$value) }
function Assert-Sha([string]$value) {
  if($value -cnotmatch '^[a-f0-9]{64}$') { throw 'SHA_PIN_INVALID' }
}
function Assert-Path([string]$value,[string]$tag,[bool]$required) {
  if($value -cnotmatch '^[A-Za-z]:\\' -or
     $value.Substring(2) -match '[<>:"|?*]' -or
     @($value.Substring(3) -split '\\') -contains '..' -or $value.Length -gt 260 -or
     [IO.Path]::GetFullPath($value) -cne $value) {
    throw ('UNSAFE_PATH_'+$tag)
  }
  if($required -and -not(Test-Path -LiteralPath $value -PathType Leaf)) {
    throw ('MISSING_'+$tag)
  }
  $cur=if(Test-Path -LiteralPath $value) { $value } else { [IO.Path]::GetDirectoryName($value) }
  for($i=0;$i -lt 40;$i++) {
    if(Test-Path -LiteralPath $cur) {
      $o=Get-Item -LiteralPath $cur -Force -ErrorAction Stop
      if(($o.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('REPARSE_'+$tag)
      }
    }
    $parent=[IO.Path]::GetDirectoryName($cur.TrimEnd('\'))
    if([string]::IsNullOrWhiteSpace($parent) -or $parent -ieq $cur) { break }
    $cur=$parent
  }
}
# A protected Supervisor release/token must not be stored in a user-writable
# checkout or %LOCALAPPDATA%. This checks only the P520 owner-protected scope.
function Assert-ProtectedLocation([string]$target,[string]$tag) {
  $base=[IO.Path]::GetFullPath((Join-Path $env:ProgramData 'KMJ-CodeBridge\P520')).TrimEnd('\')
  $targetFull=[IO.Path]::GetFullPath($target)
  if(-not $targetFull.StartsWith($base+'\', [StringComparison]::OrdinalIgnoreCase)) {
    throw ('OUTSIDE_PROTECTED_P520_ROOT_'+$tag)
  }
  if(-not(Test-Path -LiteralPath $base -PathType Container)) {
    throw 'OWNER_PROTECTED_ROOT_NOT_PROVISIONED'
  }
  $cur=if(Test-Path -LiteralPath $targetFull -PathType Container) {
    $targetFull
  } else { [IO.Path]::GetDirectoryName($targetFull) }
  $trustedWriters=@('S-1-5-18','S-1-5-32-544')
  $writes=([Security.AccessControl.FileSystemRights]::Write -bor
           [Security.AccessControl.FileSystemRights]::Modify -bor
           [Security.AccessControl.FileSystemRights]::FullControl -bor
           [Security.AccessControl.FileSystemRights]::Delete)
  for($i=0;$i -lt 32;$i++) {
    if(-not $cur.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) {
      throw ('PROTECTED_ANCESTRY_INVALID_'+$tag)
    }
    if(Test-Path -LiteralPath $cur -PathType Container) {
      $item=Get-Item -LiteralPath $cur -Force -ErrorAction Stop
      if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('PROTECTED_REPARSE_'+$tag)
      }
      $acl=Get-Acl -LiteralPath $cur -ErrorAction Stop
      $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      if($owner -notin @('S-1-5-18','S-1-5-32-544')) {
        throw ('PROTECTED_OWNER_NOT_ADMIN_'+$tag)
      }
      foreach($ace in $acl.Access) {
        $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
           $sid -notin $trustedWriters -and (($ace.FileSystemRights -band $writes) -ne 0)) {
          throw ('PROTECTED_UNAPPROVED_WRITER_'+$tag)
        }
      }
    }
    if($cur -ieq $base) { return }
    $cur=[IO.Path]::GetDirectoryName($cur.TrimEnd('\'))
    if([string]::IsNullOrWhiteSpace($cur)) { break }
  }
  throw ('PROTECTED_ACL_UNVERIFIED_'+$tag)
}
function Assert-Hash([string]$file,[string]$sha) {
  $actual=(Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  if($actual -cne $sha) { throw 'PINNED_ARTIFACT_MISMATCH' }
}
try {
  if($env:OS -cne 'Windows_NT' -or $env:COMPUTERNAME -ine 'DESKTOP-5FVJMET' -or
     -not [Environment]::Is64BitOperatingSystem) { throw 'WRONG_P520' }
  $pc=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  if($pc.Manufacturer -notmatch '(?i)lenovo' -or [string]$pc.Model -cne '30BFS1JG13') {
    throw 'HARDWARE_MISMATCH'
  }
  if($ExpectedRuntimeGitSha -cnotmatch '^[a-f0-9]{40}  Assert-Path $AgentConfig 'AGENT_CONFIG' $true
  Assert-Path $SupervisorConfig 'SUPERVISOR_CONFIG' $true
  Assert-Path $RuntimeDir 'RUNTIME_DIR' $false
  Assert-Path $BackupRoot 'BACKUP_ROOT' $false
  $cli=Join-Path $RuntimeDir 'src\cli.js'
  Assert-Path $cli 'RUNTIME_CLI' $true
  $installer=Join-Path $PSScriptRoot 'install-windows-supervisor.ps1'
  Assert-Path $installer 'INSTALLER' $true
  Assert-Hash $AgentConfig $AgentConfigSha256
  Assert-Hash $SupervisorConfig $SupervisorConfigSha256
  Assert-Hash $cli $RuntimeEntrySha256
  Assert-Hash $installer $InstallerSha256

  # Hash and inspect the selected Node without executing it in dry-run.
  $node=Get-Command node.exe -ErrorAction Stop
  if($null -eq $node -or $node.CommandType -ne 'Application') { throw 'NODE_UNTRUSTED' }
  Assert-Path ([string]$node.Source) 'NODE_EXE' $true
  Assert-Hash ([string]$node.Source) $NodeExeSha256
  $major=[int](Get-Item -LiteralPath ([string]$node.Source)).VersionInfo.FileMajorPart
  if($major -lt 24) { throw 'NODE_24_REQUIRED' }

  # Require a clean, immutable, exact-sha isolated Git release. Neither the
  # user's dirty main checkout nor a mutable main branch is a trusted runtime.
  $git=Get-Command git.exe -ErrorAction Stop
  if($null -eq $git -or $git.CommandType -ne 'Application') { throw 'GIT_UNTRUSTED' }
  Assert-Path ([string]$git.Source) 'GIT_EXE' $true
  Assert-Hash ([string]$git.Source) $GitExeSha256
  if(-not(Test-Path -LiteralPath (Join-Path $RuntimeDir '.git'))) { throw 'RUNTIME_NOT_GIT_RELEASE' }
  $actualGitSha=[string](& $git.Source -C $RuntimeDir rev-parse HEAD)
  if($LASTEXITCODE -ne 0 -or $actualGitSha.Trim() -cne $ExpectedRuntimeGitSha) {
    throw 'RUNTIME_GIT_SHA_MISMATCH'
  }
  $origin=[string](& $git.Source -C $RuntimeDir remote get-url origin)
  if($LASTEXITCODE -ne 0 -or $origin.Trim() -cne 'https://github.com/kmjtechno/kmj-codebridge.git') {
    throw 'RUNTIME_GIT_ORIGIN_MISMATCH'
  }
  $status=@(& $git.Source -C $RuntimeDir status --porcelain=v1 --untracked-files=all)
  if($LASTEXITCODE -ne 0 -or $status.Count -ne 0) { throw 'RUNTIME_CHECKOUT_DIRTY' }

  $agent=Get-Content -LiteralPath $AgentConfig -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  if([string]$agent.id -cne $expectedDevice) { throw 'WRONG_AGENT_ID' }
  if([string]$agent.gateway -cne 'https://kmjtechno.com/mcp') { throw 'WRONG_GATEWAY' }
  if(@($agent.projects | Where-Object { [string]$_.id -ceq 'kmj-codebridge' }).Count -ne 1) {
    throw 'PROJECT_IDENTITY_AMBIGUOUS'
  }
  if(@($agent.PSObject.Properties.Name | Where-Object { $_ -in @('supervisorSocket','supervisorPipe','supervisorTokenFile') }).Count -gt 0) {
    throw 'EXISTING_SUPERVISOR_BINDING'
  }
  $cfg=Get-Content -LiteralPath $SupervisorConfig -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  if([string]$cfg.pipeName -cne $pipeName -or
     [string]$cfg.agent.configPath -cne $AgentConfig -or
     [string]$cfg.agent.installDir -cne $RuntimeDir) {
    throw 'SUPERVISOR_CONFIG_MISMATCH'
  }
  $token=[string]$cfg.tokenFile
  Assert-Path $token 'TOKEN_TARGET' $false
  if(Test-Path -LiteralPath $token) { throw 'TOKEN_ALREADY_EXISTS' }
  if(Test-Path -LiteralPath ($AgentConfig+'.proposed')) { throw 'PROPOSED_CONFIG_ALREADY_EXISTS' }
  if($ServiceAccount -cnotmatch '^[A-Za-z0-9_.-]{1,64}(?:\\[A-Za-z0-9_.-]{1,64})?$') {
    throw 'SERVICE_ACCOUNT_INVALID'
  }
  $tasks=@(Get-ScheduledTask -ErrorAction Stop)
  if(@($tasks | Where-Object { [string]$_.TaskName -ieq $taskName }).Count -ne 0) {
    throw 'TASK_NAME_COLLISION'
  }

  Mark 'P520_PREPARE_DEVICE' 'PASS'
  Mark 'P520_PREPARE_PINNED_ARTIFACTS' 'PASS'
  Mark 'P520_PREPARE_TASK_COLLISION' 'NONE'
  Mark 'P520_PREPARE_MODE' $(if($Apply){'DISABLED_ONLY'}else{'DRY_RUN'})
  Mark 'P520_PREPARE_AI_OWNER_WITNESS' 'NOT_ESTABLISHED'
  Mark 'P520_PREPARE_EXISTING_AGENTS' 'UNTOUCHED'
  if(-not $Apply) {
    Mark 'P520_PREPARE_RESULT' 'DRY_RUN_PASS_NO_CHANGES'
    exit 0
  }
  if(-not $ConfirmDisabledPreparation) { throw 'OWNER_CONFIRMATION_REQUIRED' }
  $who=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $who.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'ADMINISTRATOR_REQUIRED'
  }
  Assert-ProtectedLocation $SupervisorConfig 'SUPERVISOR_CONFIG'
  Assert-ProtectedLocation $RuntimeDir 'RUNTIME'
  Assert-ProtectedLocation $BackupRoot 'BACKUP_ROOT'
  Assert-ProtectedLocation $token 'TOKEN'
  Assert-Hash $AgentConfig $AgentConfigSha256
  Assert-Hash $SupervisorConfig $SupervisorConfigSha256
  Assert-Hash $cli $RuntimeEntrySha256
  Assert-Hash ([string]$node.Source) $NodeExeSha256
  Assert-Hash ([string]$git.Source) $GitExeSha256
  Assert-Hash $installer $InstallerSha256
  $installerParams=@{
    SupervisorConfig=$SupervisorConfig
    AgentConfig=$AgentConfig
    RuntimeDir=$RuntimeDir
    BackupRoot=$BackupRoot
    ServiceAccount=$ServiceAccount
    TaskName=$taskName
    Apply=$true
  }
  & $installer @installerParams
  if(-not $?) { throw 'PREPARATION_FAILED' }
  $task=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
  if(@($task).Count -ne 1 -or [string]$task.State -cne 'Disabled') {
    throw 'TASK_NOT_DISABLED'
  }
  Mark 'P520_PREPARE_RESULT' 'DISABLED_TASK_ONLY'
  Mark 'P520_LOCAL_AI_ACTIVATION' 'NOT_ATTEMPTED'
} catch {
  $reason=[string]$_.Exception.Message
  if($reason -notmatch '^[A-Z][A-Z0-9_]{3,90}$') { $reason='SAFE_PREPARATION_BLOCKED' }
  Mark 'P520_PREPARE_RESULT' ('BLOCKED_'+$reason)
  Mark 'P520_PREPARE_EXISTING_AGENTS' 'UNTOUCHED'
  exit 2
}
) { throw 'RUNTIME_GIT_SHA_PIN_INVALID' }
  foreach($pin in @($AgentConfigSha256,$SupervisorConfigSha256,$RuntimeEntrySha256,$NodeExeSha256,$GitExeSha256,$InstallerSha256)) {
    Assert-Sha $pin
  }
  Assert-Path $AgentConfig 'AGENT_CONFIG' $true
  Assert-Path $SupervisorConfig 'SUPERVISOR_CONFIG' $true
  Assert-Path $RuntimeDir 'RUNTIME_DIR' $false
  Assert-Path $BackupRoot 'BACKUP_ROOT' $false
  $cli=Join-Path $RuntimeDir 'src\cli.js'
  Assert-Path $cli 'RUNTIME_CLI' $true
  $installer=Join-Path $PSScriptRoot 'install-windows-supervisor.ps1'
  Assert-Path $installer 'INSTALLER' $true
  Assert-Hash $AgentConfig $AgentConfigSha256
  Assert-Hash $SupervisorConfig $SupervisorConfigSha256
  Assert-Hash $cli $RuntimeEntrySha256
  Assert-Hash $installer $InstallerSha256

  # Hash and inspect the selected Node without executing it in dry-run.
  $node=Get-Command node.exe -ErrorAction Stop
  if($null -eq $node -or $node.CommandType -ne 'Application') { throw 'NODE_UNTRUSTED' }
  Assert-Path ([string]$node.Source) 'NODE_EXE' $true
  Assert-Hash ([string]$node.Source) $NodeExeSha256
  $major=[int](Get-Item -LiteralPath ([string]$node.Source)).VersionInfo.FileMajorPart
  if($major -lt 24) { throw 'NODE_24_REQUIRED' }

  # Require a clean, immutable, exact-sha isolated Git release. Neither the
  # user's dirty main checkout nor a mutable main branch is a trusted runtime.
  $git=Get-Command git.exe -ErrorAction Stop
  if($null -eq $git -or $git.CommandType -ne 'Application') { throw 'GIT_UNTRUSTED' }
  Assert-Path ([string]$git.Source) 'GIT_EXE' $true
  Assert-Hash ([string]$git.Source) $GitExeSha256
  if(-not(Test-Path -LiteralPath (Join-Path $RuntimeDir '.git'))) { throw 'RUNTIME_NOT_GIT_RELEASE' }
  $actualGitSha=[string](& $git.Source -C $RuntimeDir rev-parse HEAD)
  if($LASTEXITCODE -ne 0 -or $actualGitSha.Trim() -cne $ExpectedRuntimeGitSha) {
    throw 'RUNTIME_GIT_SHA_MISMATCH'
  }
  $origin=[string](& $git.Source -C $RuntimeDir remote get-url origin)
  if($LASTEXITCODE -ne 0 -or $origin.Trim() -cne 'https://github.com/kmjtechno/kmj-codebridge.git') {
    throw 'RUNTIME_GIT_ORIGIN_MISMATCH'
  }
  $status=@(& $git.Source -C $RuntimeDir status --porcelain=v1 --untracked-files=all)
  if($LASTEXITCODE -ne 0 -or $status.Count -ne 0) { throw 'RUNTIME_CHECKOUT_DIRTY' }

  $agent=Get-Content -LiteralPath $AgentConfig -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  if([string]$agent.id -cne $expectedDevice) { throw 'WRONG_AGENT_ID' }
  if([string]$agent.gateway -cne 'https://kmjtechno.com/mcp') { throw 'WRONG_GATEWAY' }
  if(@($agent.projects | Where-Object { [string]$_.id -ceq 'kmj-codebridge' }).Count -ne 1) {
    throw 'PROJECT_IDENTITY_AMBIGUOUS'
  }
  if(@($agent.PSObject.Properties.Name | Where-Object { $_ -in @('supervisorSocket','supervisorPipe','supervisorTokenFile') }).Count -gt 0) {
    throw 'EXISTING_SUPERVISOR_BINDING'
  }
  $cfg=Get-Content -LiteralPath $SupervisorConfig -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  if([string]$cfg.pipeName -cne $pipeName -or
     [string]$cfg.agent.configPath -cne $AgentConfig -or
     [string]$cfg.agent.installDir -cne $RuntimeDir) {
    throw 'SUPERVISOR_CONFIG_MISMATCH'
  }
  $token=[string]$cfg.tokenFile
  Assert-Path $token 'TOKEN_TARGET' $false
  if(Test-Path -LiteralPath $token) { throw 'TOKEN_ALREADY_EXISTS' }
  if(Test-Path -LiteralPath ($AgentConfig+'.proposed')) { throw 'PROPOSED_CONFIG_ALREADY_EXISTS' }
  if($ServiceAccount -cnotmatch '^[A-Za-z0-9_.-]{1,64}(?:\\[A-Za-z0-9_.-]{1,64})?$') {
    throw 'SERVICE_ACCOUNT_INVALID'
  }
  $tasks=@(Get-ScheduledTask -ErrorAction Stop)
  if(@($tasks | Where-Object { [string]$_.TaskName -ieq $taskName }).Count -ne 0) {
    throw 'TASK_NAME_COLLISION'
  }

  Mark 'P520_PREPARE_DEVICE' 'PASS'
  Mark 'P520_PREPARE_PINNED_ARTIFACTS' 'PASS'
  Mark 'P520_PREPARE_TASK_COLLISION' 'NONE'
  Mark 'P520_PREPARE_MODE' $(if($Apply){'DISABLED_ONLY'}else{'DRY_RUN'})
  Mark 'P520_PREPARE_AI_OWNER_WITNESS' 'NOT_ESTABLISHED'
  Mark 'P520_PREPARE_EXISTING_AGENTS' 'UNTOUCHED'
  if(-not $Apply) {
    Mark 'P520_PREPARE_RESULT' 'DRY_RUN_PASS_NO_CHANGES'
    exit 0
  }
  if(-not $ConfirmDisabledPreparation) { throw 'OWNER_CONFIRMATION_REQUIRED' }
  $who=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $who.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'ADMINISTRATOR_REQUIRED'
  }
  Assert-ProtectedLocation $SupervisorConfig 'SUPERVISOR_CONFIG'
  Assert-ProtectedLocation $RuntimeDir 'RUNTIME'
  Assert-ProtectedLocation $BackupRoot 'BACKUP_ROOT'
  Assert-ProtectedLocation $token 'TOKEN'
  Assert-Hash $AgentConfig $AgentConfigSha256
  Assert-Hash $SupervisorConfig $SupervisorConfigSha256
  Assert-Hash $cli $RuntimeEntrySha256
  Assert-Hash ([string]$node.Source) $NodeExeSha256
  Assert-Hash ([string]$git.Source) $GitExeSha256
  Assert-Hash $installer $InstallerSha256
  $installerParams=@{
    SupervisorConfig=$SupervisorConfig
    AgentConfig=$AgentConfig
    RuntimeDir=$RuntimeDir
    BackupRoot=$BackupRoot
    ServiceAccount=$ServiceAccount
    TaskName=$taskName
    Apply=$true
  }
  & $installer @installerParams
  if(-not $?) { throw 'PREPARATION_FAILED' }
  $task=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
  if(@($task).Count -ne 1 -or [string]$task.State -cne 'Disabled') {
    throw 'TASK_NOT_DISABLED'
  }
  Mark 'P520_PREPARE_RESULT' 'DISABLED_TASK_ONLY'
  Mark 'P520_LOCAL_AI_ACTIVATION' 'NOT_ATTEMPTED'
} catch {
  $reason=[string]$_.Exception.Message
  if($reason -notmatch '^[A-Z][A-Z0-9_]{3,90}$') { $reason='SAFE_PREPARATION_BLOCKED' }
  Mark 'P520_PREPARE_RESULT' ('BLOCKED_'+$reason)
  Mark 'P520_PREPARE_EXISTING_AGENTS' 'UNTOUCHED'
  exit 2
}
