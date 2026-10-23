# KMJ TECHNO - guarded reconnect for the already enrolled Calibration Pro device.
# Current user only; never install, re-pair, copy tokens, kill agents or edit projects.
[CmdletBinding()]
param([string]$ConfigPath, [switch]$CheckOnly, [switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedDevice = 'kmj-homeoffice-desktop-5fvjmet'
$expectedProject = 'kmj-calibration-pro'
$trustedGateway = 'https://kmjtechno.com'
$trustedOrigin = @(
  'https://github.com/kmjtechno/kmj-codebridge.git',
  'https://github.com/kmjtechno/kmj-codebridge',
  'git@github.com:kmjtechno/kmj-codebridge.git'
)
$productOrigin = @(
  'https://github.com/kmjtechno/kmj-calibration-pro.git',
  'https://github.com/kmjtechno/kmj-calibration-pro',
  'git@github.com:kmjtechno/kmj-calibration-pro.git'
)

function Assert-TrustedPath([string]$Path, [bool]$Directory) {
  if (-not [IO.Path]::IsPathRooted($Path)) { throw 'PATH_MUST_BE_ABSOLUTE' }
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.PSIsContainer -ne $Directory) { throw 'PATH_TYPE_MISMATCH' }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'REPARSE_PATH_BLOCKED'
  }
  # FileInfo has Directory but not Parent. Walk ancestors from its directory.
  $cursor = $item
  if (-not $Directory) { $cursor = $item.Directory }
  while ($null -ne $cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'REPARSE_PATH_BLOCKED'
    }
    $cursor = $cursor.Parent
  }
}
function PrivatePath([string]$Path) {
  return [bool]($Path -match '(?i)(^|[\\/])private[\\/]')
}
function HasProperty($Value, [string]$Key) {
  return $null -ne $Value -and $Value.PSObject.Properties.Name -contains $Key
}
function ApprovedScope($Config) {
  if ($null -eq $Config -or
      [string]$Config.id -cne $expectedDevice -or
      [string]$Config.tenant -notmatch '^[A-Za-z0-9_-]{1,64}$' -or
      [string]$Config.gateway -cnotin @($trustedGateway, ($trustedGateway + '/')) -or
      @($Config.projects).Count -ne 1 -or
      [string]$Config.projects[0].id -cne $expectedProject -or
      -not [IO.Path]::IsPathRooted([string]$Config.projects[0].root) -or
      -not [IO.Path]::IsPathRooted([string]$Config.stateDir) -or
      -not (PrivatePath ([string]$Config.stateDir))) { return $false }
  $inline = HasProperty $Config 'token'
  $tokenFile = HasProperty $Config 'gatewayTokenFile'
  if ($inline -and -not [string]::IsNullOrEmpty([string]$Config.token)) {
    return ([string]$Config.token).Length -ge 32 -and
      ([string]$Config.token).Length -le 8192 -and -not $tokenFile
  }
  return $tokenFile -and [IO.Path]::IsPathRooted([string]$Config.gatewayTokenFile) -and
    (PrivatePath ([string]$Config.gatewayTokenFile))
}
function ScopedAgents([string]$ConfigFile) {
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.IndexOf($ConfigFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CommandLine -match 'src[\\/]cli\.js' -and
      $_.CommandLine -match '\bagent\b'
    })
}
function ExistingLock([string]$State) {
  $file = Join-Path $State 'agent.lock'
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  Assert-TrustedPath $file $false
  $raw = Get-Content -LiteralPath $file -Raw -ErrorAction Stop
  if ($raw.Length -gt 2048) { throw 'INVALID_AGENT_LOCK' }
  if ($raw.Trim() -match '^[1-9][0-9]*$') { return [int]$raw.Trim() }
  $json = $raw | ConvertFrom-Json -ErrorAction Stop
  if ($null -eq $json -or [int]$json.pid -le 0) { throw 'INVALID_AGENT_LOCK' }
  return [int]$json.pid
}
function FreshConnection([string]$State, [datetime]$Since) {
  $file = Join-Path $State 'connection.json'
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  Assert-TrustedPath $file $false
  $record = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  $time = [datetime]::Parse([string]$record.connectedAt).ToUniversalTime()
  return $time -ge $Since.AddSeconds(-2) -and $time -le [datetime]::UtcNow.AddSeconds(10)
}
function ProtectedGateway {
  try {
    $null = Invoke-WebRequest -Uri ($trustedGateway + '/agent/health') -Method Post -ContentType 'application/json' -Body '{}' -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 15
    throw 'ANONYMOUS_ACCESS_UNEXPECTED'
  } catch [System.Net.WebException] {
    if ($null -eq $_.Exception.Response -or
        [int]$_.Exception.Response.StatusCode -ne 401) {
      throw 'GATEWAY_UNREACHABLE_OR_UNPROTECTED'
    }
  }
}
function GitValue([string]$Root, [string[]]$Args) {
  $raw = & git.exe -C $Root @Args
  if ($LASTEXITCODE -ne 0) { throw 'GIT_VERIFICATION_FAILED' }
  return ([string]($raw | Select-Object -First 1)).Trim()
}
try {
  if ($env:OS -cne 'Windows_NT') { throw 'WINDOWS_ONLY' }
  if ($SelfTest) {
    $test = [pscustomobject]@{
      id = $expectedDevice
      tenant = 'tenant1'
      gateway = $trustedGateway
      token = ('x' * 32)
      stateDir = 'C:\KMJ\private\calibration\state'
      projects = @([pscustomobject]@{ id = $expectedProject; root = 'C:\KMJ\calibration' })
    }
    if (!(ApprovedScope $test)) { throw 'SELFTEST_ACCEPTED_SCOPE_REJECTED' }
    $test.gateway = 'https://example.invalid'
    if (ApprovedScope $test) { throw 'SELFTEST_FOREIGN_GATEWAY_ACCEPTED' }
    $test.gateway = $trustedGateway
    $test.projects[0].id = 'kmj-cinecore'
    if (ApprovedScope $test) { throw 'SELFTEST_FOREIGN_PROJECT_ACCEPTED' }
    $test.projects[0].id = $expectedProject
    $test.id = 'kmj-p720-calibration-desktop-k3ahhem'
    if (ApprovedScope $test) { throw 'SELFTEST_FOREIGN_DEVICE_ACCEPTED' }
    Write-Output 'CALIBRATION_RECONNECT_SELFTEST=PASS'
    exit 0
  }

  # A single file selection replaces pasting private paths into a terminal.
  if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object System.Windows.Forms.OpenFileDialog
    $picker.Title = 'Choose your existing private Calibration Pro agent.json (no new pairing)'
    $picker.Filter = 'Existing agent.json|agent.json'
    $picker.CheckFileExists = $true
    $picker.Multiselect = $false
    try {
      if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        throw 'OWNER_CANCELLED_SELECTION'
      }
      $ConfigPath = $picker.FileName
    } finally {
      $picker.Dispose()
    }
  }

  $ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
  if ([IO.Path]::GetFileName($ConfigPath) -cne 'agent.json' -or
      -not (PrivatePath $ConfigPath)) { throw 'PRIVATE_CONFIG_REQUIRED' }
  Assert-TrustedPath $ConfigPath $false
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json -ErrorAction Stop
  if (!(ApprovedScope $config)) { throw 'ENROLLED_SCOPE_MISMATCH' }
  $state = [IO.Path]::GetFullPath([string]$config.stateDir)
  $projectRoot = [IO.Path]::GetFullPath([string]$config.projects[0].root)
  Assert-TrustedPath $state $true
  Assert-TrustedPath $projectRoot $true
  if (HasProperty $config 'gatewayTokenFile') {
    Assert-TrustedPath ([string]$config.gatewayTokenFile) $false
  }

  $runtime = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  $entry = Join-Path $runtime 'src\cli.js'
  Assert-TrustedPath $runtime $true
  Assert-TrustedPath $entry $false
  Assert-TrustedPath (Join-Path $runtime 'node_modules\zod\package.json') $false
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $null = Get-Command git.exe -ErrorAction Stop
  Assert-TrustedPath $node $false
  $nodeVersion = [string](& $node --version)
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or
      [int]$Matches[1] -lt 24) { throw 'NODE24_REQUIRED' }
  $head = GitValue $runtime @('rev-parse','--verify','HEAD')
  if ($head -notmatch '^[0-9a-f]{40}$') { throw 'SOURCE_SHA_INVALID' }
  $origin = GitValue $runtime @('remote','get-url','origin')
  if ($origin -cnotin $trustedOrigin) { throw 'UNTRUSTED_RUNTIME_ORIGIN' }
  $dirty = @(& git.exe -C $runtime status --porcelain=v1 --untracked-files=no)
  if ($LASTEXITCODE -ne 0 -or @($dirty).Count -ne 0) {
    throw 'RUNTIME_TRACKED_CHANGES'
  }
  $productRemote = GitValue $projectRoot @('remote','get-url','origin')
  if ($productRemote -cnotin $productOrigin) { throw 'UNTRUSTED_CALIBRATION_REPOSITORY' }

  $agents = @(ScopedAgents $ConfigPath)
  if ($agents.Count -gt 1) { throw 'DUPLICATE_SCOPED_AGENTS' }
  $owner = ExistingLock $state
  if ($agents.Count -eq 1) {
    if ($null -ne $owner -and $owner -ne [int]$agents[0].ProcessId) {
      throw 'AGENT_LOCK_OWNER_MISMATCH'
    }
    Write-Output 'CALIBRATION_RECONNECT=ALREADY_RUNNING_LOCALLY'
    Write-Output 'ACCOUNT_GRANT=CHECK_CODEBRIDGE_CONNECTION_OVERVIEW'
    Write-Output 'NO_DUPLICATE_AGENT=PASS'
    exit 0
  }
  if ($null -ne $owner -and
      $null -ne (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {
    throw 'AGENT_LOCK_OWNER_ALIVE'
  }
  ProtectedGateway
  Write-Output 'CALIBRATION_RECONNECT_PREFLIGHT=PASS'
  Write-Output 'CALIBRATION_RECONNECT_RUNTIME=TRUSTED_CLEAN_HEAD'
  if ($CheckOnly) {
    Write-Output 'CALIBRATION_RECONNECT=DRY_RUN'
    exit 0
  }

  $marker = [guid]::NewGuid().ToString('N')
  $out = Join-Path $state ('calibration-reconnect-' + $marker + '.out.log')
  $err = Join-Path $state ('calibration-reconnect-' + $marker + '.err.log')
  $since = [datetime]::UtcNow
  # A single scoped process. No shell, task registration, reboot, kill or checkout writes.
  $quoted = '"' + $entry + '" agent "' + $ConfigPath + '"'
  $proc = Start-Process -FilePath $node -ArgumentList $quoted -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    $proc.Refresh()
    if ($proc.HasExited) { throw 'AGENT_EXITED_BEFORE_HEARTBEAT' }
    $live = @(ScopedAgents $ConfigPath)
    if ($live.Count -ne 1 -or [int]$live[0].ProcessId -ne $proc.Id) {
      throw 'AGENT_SCOPE_RACE_DETECTED'
    }
    if (FreshConnection $state $since) {
      Write-Output 'CALIBRATION_RECONNECT=LOCAL_AUTHENTICATED_HEARTBEAT'
      Write-Output 'ACCOUNT_GRANT=CHECK_CODEBRIDGE_CONNECTION_OVERVIEW'
      Write-Output 'ENROLLMENT=UNCHANGED'
      Write-Output 'OWNER_CHECKOUT=UNTOUCHED'
      exit 0
    }
  }
  throw 'FRESH_AUTHENTICATED_HEARTBEAT_MISSING'
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{2,100}$') {
    $code = 'LOCAL_VALIDATION_OR_RUNTIME_FAILED'
  }
  Write-Output ('CALIBRATION_RECONNECT=BLOCKED:' + $code)
  Write-Output 'ENROLLMENT=UNCHANGED'
  Write-Output 'OWNER_CHECKOUT=UNTOUCHED'
  exit 2
}
