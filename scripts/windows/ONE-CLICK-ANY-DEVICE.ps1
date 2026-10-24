# KMJ CodeBridge — universal current-user Windows one-click connect and auto-reconnect.
# Browser-approved pairing only for NEW devices; existing credentials are never exported.
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [switch]$AtLogon,
  [switch]$DisableAutoStart,
  [switch]$SelfTest
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$gateway = 'https://kmjtechno.com'
$approvedRuntimeOrigins = @(
  'https://github.com/kmjtechno/kmj-codebridge',
  'https://github.com/kmjtechno/kmj-codebridge.git',
  'git@github.com:kmjtechno/kmj-codebridge.git'
)
$privateRoot = Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\private\devices'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$hostSlug = ([string]$env:COMPUTERNAME -replace '[^A-Za-z0-9_-]', '-').ToLowerInvariant()
if ($hostSlug.Length -gt 40) { $hostSlug = $hostSlug.Substring(0,40) }

function Ordinary([string]$Value,[bool]$Dir) {
  if (![IO.Path]::IsPathRooted($Value)) { throw 'DEVICE_PATH_NOT_ABSOLUTE' }
  $item = Get-Item -LiteralPath $Value -ErrorAction Stop
  if ([bool]$item.PSIsContainer -ne $Dir) { throw 'DEVICE_PATH_TYPE_MISMATCH' }
  $cursor = if ($Dir) { $item } else { $item.Directory }
  while ($null -ne $cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'DEVICE_PATH_REPARSE_DENIED'
    }
    $cursor = $cursor.Parent
  }
}
function PrivateFile([string]$Value) {
  return [IO.Path]::GetFileName($Value) -ceq 'agent.json' -and
    $Value -match '(?i)(^|[\\/])private[\\/]'
}
function ValidScope($Cfg) {
  if ($null -eq $Cfg -or
      [string]$Cfg.id -notmatch '^[A-Za-z0-9_-]{1,64}$' -or
      !([string]$Cfg.id).EndsWith('-' + $hostSlug,[StringComparison]::OrdinalIgnoreCase) -or
      [string]$Cfg.tenant -notmatch '^[A-Za-z0-9_-]{1,64}$' -or
      [string]$Cfg.gateway -cnotin @($gateway,($gateway + '/')) -or
      [string]$Cfg.stateDir -notmatch '(?i)(^|[\\/])private[\\/]' -or
      ![IO.Path]::IsPathRooted([string]$Cfg.stateDir)) { return $false }
  $projects = @($Cfg.projects)
  if ($projects.Count -lt 1 -or $projects.Count -gt 8) { return $false }
  $ids = @{}
  foreach ($project in $projects) {
    if ([string]$project.id -notmatch '^[A-Za-z0-9_-]{1,64}$' -or
        ![IO.Path]::IsPathRooted([string]$project.root) -or
        $ids.ContainsKey([string]$project.id)) { return $false }
    $ids[[string]$project.id] = $true
  }
  $inline = $null -ne $Cfg.PSObject.Properties['token'] -and
    ![string]::IsNullOrEmpty([string]$Cfg.token)
  $tokenFile = $null -ne $Cfg.PSObject.Properties['gatewayTokenFile']
  if ($inline -eq $tokenFile) { return $false }
  if ($inline) { return ([string]$Cfg.token).Length -ge 32 -and ([string]$Cfg.token).Length -le 8192 }
  return [IO.Path]::IsPathRooted([string]$Cfg.gatewayTokenFile) -and
    [string]$Cfg.gatewayTokenFile -match '(?i)(^|[\\/])private[\\/]'
}
function ReadApproved([string]$Value) {
  if (!(PrivateFile $Value)) { throw 'DEVICE_CONFIG_MUST_BE_PRIVATE' }
  Ordinary $Value $false
  $item = Get-Item -LiteralPath $Value
  if ($item.Length -gt 262144) { throw 'DEVICE_CONFIG_OVERSIZED' }
  $cfg = Get-Content -LiteralPath $Value -Raw | ConvertFrom-Json -ErrorAction Stop
  if (!(ValidScope $cfg)) { throw 'DEVICE_ENROLLMENT_OR_HOST_SCOPE_MISMATCH' }
  Ordinary ([string]$cfg.stateDir) $true
  foreach ($pr in @($cfg.projects)) { Ordinary ([string]$pr.root) $true }
  if ($cfg.PSObject.Properties.Name -contains 'gatewayTokenFile') {
    Ordinary ([string]$cfg.gatewayTokenFile) $false
  }
  return $cfg
}
function ChooseExisting {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'KMJ CodeBridge: select EXISTING private agent.json from THIS computer'
  $dialog.Filter = 'Private approved agent|agent.json'
  $dialog.CheckFileExists = $true
  $dialog.Multiselect = $false
  try {
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
      return $null
    }
    return [IO.Path]::GetFullPath($dialog.FileName)
  } finally { $dialog.Dispose() }
}
function SelectProject {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Select the existing local Git project you want to approve for CodeBridge'
  $dialog.ShowNewFolderButton = $false
  try {
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
      throw 'DEVICE_PROJECT_SELECTION_CANCELLED'
    }
    return [IO.Path]::GetFullPath($dialog.SelectedPath)
  } finally { $dialog.Dispose() }
}
function LockedACL([string]$Value,[bool]$Dir) {
  Ordinary $Value $Dir
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $rule = if ($Dir) { '*' + $sid + ':(OI)(CI)F' } else { '*' + $sid + ':F' }
  & icacls.exe $Value '/inheritance:r' '/grant:r' $rule 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'DEVICE_PRIVATE_ACL_FAILED' }
}
function KnownGitRoot([string]$Value) {
  Ordinary $Value $true
  $top = [string]((& git.exe -C $Value rev-parse --show-toplevel 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or
      [IO.Path]::GetFullPath($top) -ine [IO.Path]::GetFullPath($Value)) {
    throw 'DEVICE_PROJECT_MUST_BE_GIT_ROOT'
  }
  $origin = [string]((& git.exe -C $Value remote get-url origin 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($origin)) {
    throw 'DEVICE_PROJECT_ORIGIN_REQUIRED'
  }
}
# Bounded discovery in known owner-private stores. No token leaves this process.
function FindKnownApproved([string]$ProjectRoot = '',[string]$ProjectId = '') {
  $stores = @(
    (Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\private'),
    'D:\KMJ-HyperSpeed\private',
    'E:\KMJ\private',
    'E:\KMJ\CodeBridge-HomeOffice\private'
  )
  $seen = @{}
  foreach ($store in $stores) {
    if (!(Test-Path -LiteralPath $store -PathType Container)) { continue }
    try { Ordinary $store $true } catch { continue }
    $files = @(Get-ChildItem -LiteralPath $store -File -Filter 'agent.json' -Recurse -Depth 6 -ErrorAction SilentlyContinue)
    foreach ($file in $files) {
      if ($file.Length -gt 262144 -or !(PrivateFile $file.FullName)) { continue }
      try {
        $full = [IO.Path]::GetFullPath($file.FullName)
        Ordinary $full $false
        $candidate = Get-Content -LiteralPath $full -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if (!(ValidScope $candidate)) { continue }
        if ($ProjectRoot -ne '') {
          $matching = @($candidate.projects | Where-Object {
            [string]$_.id -ceq $ProjectId -and
            [IO.Path]::GetFullPath([string]$_.root) -ieq $ProjectRoot
          })
          if ($matching.Count -ne 1) { continue }
        }
        $key = $full.ToLowerInvariant()
        if (!$seen.ContainsKey($key)) {
          $seen[$key] = $true
          Write-Output $full
        }
      } catch {
        # Foreign, unreadable, linked or malformed candidates are excluded.
      }
    }
  }
}

# Only a previous cancelled pairing with an EMPTY state folder may resume.
function AssertEmptyRetryState([string]$Base,[string]$State) {
  Ordinary $Base $true
  $items = @(Get-ChildItem -LiteralPath $Base -Force -ErrorAction Stop)
  if ($items.Count -ne 1 -or $items[0].Name -cne 'state') {
    throw 'DEVICE_EXISTING_PRIVATE_SETUP_REVIEW_REQUIRED'
  }
  Ordinary $State $true
  if (@(Get-ChildItem -LiteralPath $State -Force -ErrorAction Stop).Count -ne 0) {
    throw 'DEVICE_EXISTING_PRIVATE_SETUP_REVIEW_REQUIRED'
  }
}

function FirstPair {
  # Manual owner action only; NEVER called by Windows Startup.
  $projectRoot = SelectProject
  KnownGitRoot $projectRoot
  $projectId = [IO.Path]::GetFileName($projectRoot.TrimEnd([char]92))
  if ($projectId -notmatch '^[A-Za-z0-9_-]{1,48}$') {
    throw 'DEVICE_PROJECT_ID_UNSUPPORTED'
  }
  if (@(FindKnownApproved $projectRoot $projectId).Count -gt 0) {
    throw 'DEVICE_EXISTING_PROJECT_ENROLLMENT_USE_RECONNECT'
  }
  $prefix = 'kmj-' + $projectId
  $maxPrefix = 63 - $hostSlug.Length
  if ($maxPrefix -lt 6) { throw 'DEVICE_HOSTNAME_TOO_LONG' }
  if ($prefix.Length -gt $maxPrefix) { $prefix = $prefix.Substring(0,$maxPrefix) }
  $id = $prefix + '-' + $hostSlug
  $base = Join-Path $privateRoot $id
  $state = Join-Path $base 'state'
  if (!(Test-Path -LiteralPath $privateRoot)) {
    New-Item -ItemType Directory -Path $privateRoot -ErrorAction Stop | Out-Null
    LockedACL $privateRoot $true
  } else {
    Ordinary $privateRoot $true
  }
  if (Test-Path -LiteralPath $base) {
    AssertEmptyRetryState $base $state
    Write-Host 'KMJ_UNIVERSAL=EMPTY_CANCELLED_PAIRING_RETRY'
  } else {
    New-Item -ItemType Directory -Path $base,$state -ErrorAction Stop | Out-Null
  }
  LockedACL $base $true
  LockedACL $state $true
  $enrollment = Join-Path $base 'enrollment.json'
  $config = Join-Path $base 'agent.json'
  Write-Host 'KMJ_UNIVERSAL=OWNER_BROWSER_APPROVAL_REQUIRED'
  # Use NoNewWindow so owner sees ONLY the official browser URL/short-lived code.
  # Start-Process prevents those native stdout lines entering the function's
  # return value (which must contain only the private config path).
  $tool = Join-Path $repo 'scripts\enroll-device.js'
  $quoted = '"' + $tool + '" "' + $gateway + '" "' + $id + '" "' +
      $projectId + '" "' + $projectRoot + '" "' + $enrollment + '"'
  $worker = Start-Process -FilePath $node -ArgumentList $quoted -WorkingDirectory $repo -Wait -PassThru -NoNewWindow
  if ($worker.ExitCode -ne 0) { throw 'DEVICE_BROWSER_APPROVAL_DENIED_OR_EXPIRED' }
  LockedACL $enrollment $false
  $grant = Get-Content -LiteralPath $enrollment -Raw | ConvertFrom-Json -ErrorAction Stop
  if ([string]$grant.agent.id -cne $id -or
      [string]$grant.agent.tenant -notmatch '^[A-Za-z0-9_-]{1,64}$' -or
      [string]$grant.agent.token -notmatch '^.{32,8192}$' -or
      [string]$grant.gateway -cnotin @($gateway,($gateway + '/')) -or
      @($grant.projects | Where-Object { [string]$_.id -ceq $projectId }).Count -ne 1) {
    throw 'DEVICE_APPROVAL_GRANT_MISMATCH'
  }
  foreach ($action in @('read','write','execute')) {
    if (@($grant.permissions) -cnotcontains $action) { throw 'DEVICE_APPROVAL_PERMISSION_MISMATCH' }
  }
  $cfg = @{
    id = $id
    tenant = [string]$grant.agent.tenant
    token = [string]$grant.agent.token
    gateway = $gateway + '/'
    stateDir = $state
    projects = @(@{ id = $projectId; root = $projectRoot; writable = $true; gates = @{} })
    license = @{ mode = 'free' }
  }
  # An existing agent.json is NEVER overwritten, even on a retry.
  $stream = [IO.File]::Open($config,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($cfg | ConvertTo-Json -Depth 12))
    $stream.Write($bytes,0,$bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  LockedACL $config $false
  Write-Host 'KMJ_UNIVERSAL=OWNER_APPROVED_PRIVATE_CONFIG_CREATED'
  return $config
}
function UniqueProcesses([string]$Value) {
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.IndexOf($Value,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine -match 'src[\\/]cli\.js' -and
      $_.CommandLine -match '\bagent\b'
    })
}
function LockOwner([string]$State) {
  $file = Join-Path $State 'agent.lock'
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  Ordinary $file $false
  $raw = Get-Content -LiteralPath $file -Raw
  if ($raw.Length -gt 2048) { throw 'DEVICE_AGENT_LOCK_OVERSIZED' }
  if ($raw.Trim() -match '^[1-9][0-9]*$') { return [int]$raw.Trim() }
  $obj = $raw | ConvertFrom-Json -ErrorAction Stop
  if ([int]$obj.pid -le 0) { throw 'DEVICE_AGENT_LOCK_INVALID' }
  return [int]$obj.pid
}
function Heartbeat([string]$State,[datetime]$After) {
  $file = Join-Path $State 'connection.json'
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  Ordinary $file $false
  $record = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -ErrorAction Stop
  $when = [datetime]::Parse([string]$record.connectedAt).ToUniversalTime()
  return $when -ge $After.AddSeconds(-2) -and $when -le [datetime]::UtcNow.AddSeconds(10)
}
function RunApprovedAgent([string]$Value,$Cfg,[string]$Node) {
  $existing = @(UniqueProcesses $Value)
  if ($existing.Count -gt 1) { throw 'DEVICE_DUPLICATE_APPROVED_AGENTS' }
  $owner = LockOwner ([string]$Cfg.stateDir)
  if ($existing.Count -eq 1) {
    if ($null -ne $owner -and $owner -ne [int]$existing[0].ProcessId) {
      throw 'DEVICE_LOCK_PROCESS_MISMATCH'
    }
    Write-Output 'KMJ_UNIVERSAL_AGENT=ALREADY_RUNNING'
    return
  }
  if ($null -ne $owner -and (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {
    throw 'DEVICE_LIVE_LOCK_OWNER_BLOCKS_START'
  }
  $entry = Join-Path $repo 'src\cli.js'
  $n = [guid]::NewGuid().ToString('N')
  $stdout = Join-Path ([string]$Cfg.stateDir) ('oneclick-'+$n+'.out.log')
  $stderr = Join-Path ([string]$Cfg.stateDir) ('oneclick-'+$n+'.err.log')
  $after = [datetime]::UtcNow
  $commandArgs = '"' + $entry + '" agent "' + $Value + '"'
  $child = Start-Process -FilePath $Node -ArgumentList $commandArgs -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  for ($attempt=0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Seconds 2
    $child.Refresh()
    if ($child.HasExited) { throw 'DEVICE_AGENT_EXITED_BEFORE_HEARTBEAT' }
    $peers = @(UniqueProcesses $Value)
    if ($peers.Count -ne 1 -or [int]$peers[0].ProcessId -ne $child.Id) {
      throw 'DEVICE_AGENT_START_RACE_BLOCKED'
    }
    if (Heartbeat ([string]$Cfg.stateDir) $after) {
      Write-Output 'KMJ_UNIVERSAL_AGENT=LOCAL_FRESH_AUTHENTICATED_HEARTBEAT'
      return
    }
  }
  throw 'DEVICE_FRESH_HEARTBEAT_UNVERIFIED'
}
function ShortcutArgs([string]$Script,[string]$Config) {
  foreach ($p in @($Script,$Config)) {
    if ($p -notmatch '^[A-Za-z]:\\' -or $p.Contains('"')) {
      throw 'DEVICE_UNSAFE_SHORTCUT_ARGUMENT'
    }
  }
  return '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' +
    $Script + '" -AtLogon -ConfigPath "' + $Config + '"'
}
function VerifyShortcut($Link,[string]$Target,[string]$Arguments,[string]$Dir) {
  return ([IO.Path]::GetFullPath([string]$Link.TargetPath) -ieq [IO.Path]::GetFullPath($Target)) -and
    ([string]$Link.Arguments -ceq $Arguments) -and
    ([IO.Path]::GetFullPath([string]$Link.WorkingDirectory) -ieq [IO.Path]::GetFullPath($Dir))
}
function ShortcutFile([string]$Value,[string]$Folder) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $key = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value.ToLowerInvariant())) }
  finally { $sha.Dispose() }
  $hash = [BitConverter]::ToString($key).Replace('-','').Substring(0,16).ToLowerInvariant()
  return Join-Path $Folder ('KMJ CodeBridge Device ' + $hash + '.lnk')
}
try {
  if ($env:OS -cne 'Windows_NT') { throw 'DEVICE_WINDOWS_REQUIRED' }
  if ($SelfTest) {
    # Disposable Windows COM .lnk validation. Real user Startup untouched.
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('kmj-universal-test-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
    try {
      $sh = New-Object -ComObject WScript.Shell
      $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $fake = 'C:\KMJ\private\devices\test\agent.json'
      $argv = ShortcutArgs $PSCommandPath $fake
      $file = ShortcutFile $fake $dir
      $link = $sh.CreateShortcut($file)
      $link.TargetPath = $ps
      $link.Arguments = $argv
      $link.WorkingDirectory = $dir
      $link.Save()
      $fresh = $sh.CreateShortcut($file)
      if (!(VerifyShortcut $fresh $ps $argv $dir) -or
          (VerifyShortcut $fresh $ps ($argv + ' extra') $dir)) {
        throw 'DEVICE_TEST_SHORTCUT_VALIDATION_FAILED'
      }
      $fakeCfg = [pscustomobject]@{
        id=('kmj-test-' + $hostSlug); tenant='test'; token=('x' * 32)
        gateway=$gateway; stateDir='C:\KMJ\private\devices\test\state'
        projects=@([pscustomobject]@{id='test';root='C:\KMJ\test'})
      }
      if (!(ValidScope $fakeCfg)) { throw 'DEVICE_TEST_VALID_SCOPE_REJECTED' }
      $fakeCfg.id = 'kmj-device-another-pc'
      if (ValidScope $fakeCfg) { throw 'DEVICE_TEST_FOREIGN_HOST_ALLOWED' }
      # Prove a cancelled empty enrollment can be retried but a credential,
      # log or other content is never deleted or silently resumed.
      $pairBase = Join-Path $dir 'cancelled-pair'
      $pairState = Join-Path $pairBase 'state'
      New-Item -ItemType Directory -Path $pairState -Force -ErrorAction Stop | Out-Null
      AssertEmptyRetryState $pairBase $pairState
      $credentialFixture = Join-Path $pairBase 'enrollment.json'
      [IO.File]::WriteAllText($credentialFixture, 'DO_NOT_OVERWRITE')
      $blocked = $false
      try { AssertEmptyRetryState $pairBase $pairState }
      catch {
        if ($_.Exception.Message -ne 'DEVICE_EXISTING_PRIVATE_SETUP_REVIEW_REQUIRED') { throw }
        $blocked = $true
      }
      if (!$blocked -or [IO.File]::ReadAllText($credentialFixture) -cne 'DO_NOT_OVERWRITE') {
        throw 'DEVICE_TEST_EXISTING_ENROLLMENT_NOT_PRESERVED'
      }
      Write-Output 'KMJ_UNIVERSAL_RETRY_SELFTEST=PASS'
      Write-Output 'KMJ_UNIVERSAL_SELFTEST=PASS'
      Write-Output 'REAL_STARTUP_CHANGED=NO'
    } finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
    exit 0
  }
  if ([string]::IsNullOrEmpty($hostSlug)) { throw 'DEVICE_HOST_ID_MISSING' }
  Ordinary $repo $true
  Ordinary $PSCommandPath $false
  $git = (Get-Command git.exe -ErrorAction Stop).Source
  $origin = [string]((& $git -C $repo remote get-url origin 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $origin.Trim() -cnotin $approvedRuntimeOrigins) {
    throw 'DEVICE_CODEBRIDGE_RUNTIME_UNTRUSTED'
  }
  $top = [string]((& $git -C $repo rev-parse --show-toplevel 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($top) -ine $repo) {
    throw 'DEVICE_CODEBRIDGE_ROOT_MISMATCH'
  }
  $dirty = @(& $git --no-optional-locks -C $repo status --porcelain=v1 --untracked-files=no)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw 'DEVICE_CODEBRIDGE_RUNTIME_DIRTY_PRESERVED'
  }
  $tracked = @('scripts/windows/ONE-CLICK-ANY-DEVICE.ps1','scripts/enroll-device.js','src/cli.js')
  $null = & $git -C $repo ls-files --error-unmatch -- @tracked 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'DEVICE_UNTRACKED_LAUNCHER_BLOCKED' }
  Ordinary (Join-Path $repo 'src\cli.js') $false
  Ordinary (Join-Path $repo 'node_modules\zod\package.json') $false
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Ordinary $node $false
  $version = [string](& $node --version)
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v([0-9]+)\.' -or [int]$Matches[1] -lt 24) {
    throw 'DEVICE_NODE24_REQUIRED'
  }
  if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    if ($AtLogon) { throw 'DEVICE_UNATTENDED_REQUIRES_EXACT_CONFIG' }
    if ($DisableAutoStart) {
      $known = @(FindKnownApproved)
      if ($known.Count -eq 1) {
        $ConfigPath = $known[0]
        Write-Host 'KMJ_UNIVERSAL=EXISTING_SCOPED_AGENT_AUTO_SELECTED'
      } else {
        $ConfigPath = ChooseExisting
      }
      if ([string]::IsNullOrWhiteSpace($ConfigPath)) { throw 'DEVICE_OWNER_CANCELLED' }
    } else {
    Add-Type -AssemblyName System.Windows.Forms
    $choice = [System.Windows.Forms.MessageBox]::Show(
      'Already connected a KMJ CodeBridge agent on this PC? YES: choose its existing private agent.json. NO: pair a new Git project with your owner browser.',
      'KMJ TECHNO - Connect Device',
      [System.Windows.Forms.MessageBoxButtons]::YesNoCancel
    )
    if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) {
      throw 'DEVICE_OWNER_CANCELLED'
    }
    if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
      $known = @(FindKnownApproved)
      if ($known.Count -eq 1) {
        $ConfigPath = $known[0]
        Write-Host 'KMJ_UNIVERSAL=EXISTING_SCOPED_AGENT_AUTO_SELECTED'
      } else {
        $ConfigPath = ChooseExisting
      }
      if ([string]::IsNullOrWhiteSpace($ConfigPath)) { throw 'DEVICE_OWNER_CANCELLED' }
    } else {
      $ConfigPath = FirstPair
    }
    }
  }
  $ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
  $cfg = ReadApproved $ConfigPath
  # No concurrent existing boot manager for legacy P720 enrollment.
  if ([string]$cfg.id -like 'kmj-p720-*') {
    $task = Get-ScheduledTask -TaskName 'KMJ-CodeBridge-P720-Agent' -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task -and [string]$task.State -ne 'Disabled') {
      throw 'DEVICE_EXISTING_P720_STARTUP_OWNER'
    }
  }
  $startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  Ordinary $startup $true
  $file = ShortcutFile $ConfigPath $startup
  $systemPs = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Ordinary $systemPs $false
  $params = ShortcutArgs $PSCommandPath $ConfigPath
  $shell = New-Object -ComObject WScript.Shell
  $exists = Test-Path -LiteralPath $file
  if ($exists) {
    Ordinary $file $false
    $existing = $shell.CreateShortcut($file)
    if (!(VerifyShortcut $existing $systemPs $params $repo)) {
      throw 'DEVICE_STARTUP_SHORTCUT_CONFLICT'
    }
  }
  if ($DisableAutoStart) {
    if ($exists) { Remove-Item -LiteralPath $file -ErrorAction Stop }
    Write-Output 'KMJ_UNIVERSAL=AUTOSTART_DISABLED'
    exit 0
  }
  RunApprovedAgent $ConfigPath $cfg $node
  if (!$AtLogon -and !$exists) {
    $link = $shell.CreateShortcut($file)
    $link.TargetPath = $systemPs
    $link.Arguments = $params
    $link.WorkingDirectory = $repo
    $link.Description = 'KMJ CodeBridge approved per-device startup reconnect'
    $link.WindowStyle = 7
    $link.Save()
    Ordinary $file $false
    $confirm = $shell.CreateShortcut($file)
    if (!(VerifyShortcut $confirm $systemPs $params $repo)) {
      Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
      throw 'DEVICE_STARTUP_POSTWRITE_CHECK_FAILED'
    }
    Write-Output 'KMJ_UNIVERSAL=ONE_CLICK_CURRENT_USER_AUTOSTART_ENABLED'
  } elseif ($AtLogon) {
    Write-Output 'KMJ_UNIVERSAL=SIGN_IN_RECONNECT_INVOKED'
  } else { Write-Output 'KMJ_UNIVERSAL=AUTOSTART_ALREADY_ENABLED' }
  Write-Output 'OWNER_FILES=UNTOUCHED'
  Write-Output 'ACCOUNT_READY=CHECK_AUTHENTICATED_CONNECTION_OVERVIEW'
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{3,110}$') {
    $code = 'DEVICE_SETUP_OR_RUNTIME_VALIDATION_FAILED'
  }
  Write-Output ('KMJ_UNIVERSAL=BLOCKED:' + $code)
  Write-Output 'PRIVATE_TOKENS_PRINTED=NO'
  exit 2
}
