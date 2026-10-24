# KMJ TECHNO | P520 existing enrollment only. No new pairing, no tokens disclosed.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedHost = 'DESKTOP-5FVJMET'
$pin = '9f74b7a88a3bc4f163f43c04328fe753db094354'
$originAllowed = @(
  'https://github.com/kmjtechno/kmj-codebridge.git',
  'https://github.com/kmjtechno/kmj-codebridge',
  'git@github.com:kmjtechno/kmj-codebridge.git'
)
$roots = @('E:\KMJ\CodeBridge-HomeOffice-9f74b7a88a3b', 'E:\KMJ\CodeBridge-HomeOffice')
$relative = 'scripts/windows/CONNECT-CALIBRATION-PRO.ps1'
function Mark([string]$K,[string]$Value) { Write-Output ($K + '=' + $Value) }
function Ordinary([string]$Path,[bool]$IsDirectory) {
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ([bool]$item.PSIsContainer -ne $IsDirectory) { throw 'RECOVERY_PATH_TYPE_DENIED' }
  $walk = if ($IsDirectory) { $item } else { $item.Directory }
  if (!$IsDirectory -and $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RECOVERY_REPARSE_DENIED' }
  while ($null -ne $walk) {
    if ($walk.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RECOVERY_REPARSE_DENIED' }
    $walk = $walk.Parent
  }
}
function Trusted([string]$Root,[string]$Git) {
  if (!(Test-Path -LiteralPath $Root -PathType Container)) { return $false }
  Ordinary $Root $true
  $head = [string]((& $Git --no-optional-locks -C $Root rev-parse HEAD 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $head.Trim() -cne $pin) { return $false }
  $top = [string]((& $Git --no-optional-locks -C $Root rev-parse --show-toplevel 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($top).TrimEnd([char]92) -ine [IO.Path]::GetFullPath($Root).TrimEnd([char]92)) { return $false }
  $origin = [string]((& $Git --no-optional-locks -C $Root remote get-url origin 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $origin.Trim() -cnotin $originAllowed) { return $false }
  $dirty = @(& $Git --no-optional-locks -C $Root status --porcelain=v1 --untracked-files=no 2>$null)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { return $false }
  $entry = Join-Path $Root 'scripts\windows\CONNECT-CALIBRATION-PRO.ps1'
  if (!(Test-Path -LiteralPath $entry -PathType Leaf)) { return $false }
  Ordinary $entry $false
  $expectedBlob = [string]((& $Git --no-optional-locks -C $Root rev-parse ('HEAD:' + $relative) 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $expectedBlob -notmatch '^[0-9a-f]{40}$') { return $false }
  $actualBlob = [string]((& $Git --no-optional-locks -C $Root hash-object -- $entry 2>$null) | Select-Object -First 1)
  return $LASTEXITCODE -eq 0 -and $actualBlob.Trim() -ceq $expectedBlob.Trim()
}
try {
  if ($SelfTest) {
    if ($pin -cnotmatch '^[0-9a-f]{40}$' -or $roots.Count -ne 2 -or $originAllowed.Count -ne 3) { throw 'RECOVERY_SELFTEST_INVALID' }
    Mark 'KMJ_P520_EXISTING_ONLY_SELFTEST' 'PASS'
    Mark 'NETWORK_OR_LOCAL_FILES_MODIFIED' 'NO'
    exit 0
  }
  if ($env:OS -cne 'Windows_NT' -or $env:COMPUTERNAME -ine $expectedHost) { throw 'RECOVERY_WRONG_WINDOWS_HOST' }
  Mark 'KMJ_P520_MODE' 'EXISTING_SCOPED_ENROLLMENT_ONLY'
  Mark 'KMJ_P520_OWNER_APPROVAL_BYPASSED' 'NO'
  Mark 'KMJ_P520_RUNTIME_AND_PROJECTS_MODIFIED' 'NO'
  $gitTool = Get-Command git.exe -ErrorAction SilentlyContinue
  if (!$gitTool) { throw 'RECOVERY_GIT_MISSING' }
  $git = $gitTool.Source
  $runtime = $null
  foreach ($root in $roots) {
    if (Trusted $root $git) { $runtime = $root; break }
  }
  if ($null -eq $runtime) { throw 'RECOVERY_PINNED_CLEAN_RUNTIME_MISSING' }
  Mark 'KMJ_P520_RUNTIME_SHA' $pin
  $entry = Join-Path $runtime 'scripts\windows\CONNECT-CALIBRATION-PRO.ps1'
  Ordinary $entry $false
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Ordinary $ps $false
  if ($CheckOnly) { $switches = @('-AutoDiscover','-NoPicker','-CheckOnly') }
  else { $switches = @('-AutoDiscover','-NoPicker') }
  # The source CodeBridge reconnect script validates device/project/gateway,
  # existing process locks, and private path scope before any agent starts.
  $lines = @(& $ps -NoProfile -STA -ExecutionPolicy RemoteSigned -File $entry @switches 2>$null)
  $exitCode = $LASTEXITCODE
  $safe = @($lines | Where-Object {
    $_ -is [string] -and $_.Length -le 180 -and
    $_ -match '^(CALIBRATION_RECONNECT|CALIBRATION_RECONNECT_PREFLIGHT|CALIBRATION_RECONNECT_RUNTIME|CALIBRATION_ENROLLMENT_DISCOVERY|ACCOUNT_GRANT|NO_DUPLICATE_AGENT|ENROLLMENT|OWNER_CHECKOUT)=[A-Z0-9_:]+$'
  })
  foreach ($line in $safe) { Write-Output $line }
  if (@($safe) -contains 'CALIBRATION_ENROLLMENT_DISCOVERY=NO_MATCH_IN_KNOWN_PRIVATE_STORES') {
    throw 'RECOVERY_EXISTING_SCOPED_CREDENTIAL_NOT_FOUND'
  }
  if ($exitCode -ne 0) { throw 'RECOVERY_EXISTING_AGENT_RECONNECT_FAILED' }
  if ($CheckOnly) {
    if (@($safe) -notcontains 'CALIBRATION_RECONNECT=DRY_RUN' -and @($safe) -notcontains 'CALIBRATION_RECONNECT=ALREADY_RUNNING_LOCALLY') { throw 'RECOVERY_CHECK_RESULT_UNVERIFIED' }
    Mark 'KMJ_P520_RECOVERY' 'EXISTING_ENROLLMENT_CHECK_PASSED'
    Mark 'KMJ_P520_GATEWAY_READY' 'NOT_ATTESTED'
    exit 0
  }
  if (@($safe) -contains 'CALIBRATION_RECONNECT=LOCAL_AUTHENTICATED_HEARTBEAT') {
    Mark 'KMJ_P520_RECOVERY' 'AUTHENTICATED_LOCAL_HEARTBEAT'
  } elseif (@($safe) -contains 'CALIBRATION_RECONNECT=ALREADY_RUNNING_LOCALLY') {
    Mark 'KMJ_P520_RECOVERY' 'EXISTING_AGENT_RUNNING_GATEWAY_NOT_ATTESTED'
  } else { throw 'RECOVERY_RESULT_UNVERIFIED' }
  Mark 'KMJ_P520_GATEWAY_READY' 'CHECK_CODEBRIDGE_ACCOUNT_SIDE'
  Mark 'KMJ_P520_NEW_PAIRING_STARTED' 'NO'
} catch {
  $reason = [string]$_.Exception.Message
  if ($reason -cnotmatch '^RECOVERY_[A-Z0-9_]{3,100}$') { $reason = 'RECOVERY_LOCAL_PRECONDITION_FAILED' }
  Mark 'KMJ_P520_RECOVERY' ('BLOCKED:' + $reason)
  Mark 'KMJ_P520_NEW_PAIRING_STARTED' 'NO'
  Mark 'KMJ_P520_ENROLLMENT_EXPORTED' 'NO'
  Mark 'KMJ_P520_PROJECTS_CHANGED' 'NO'
  exit 2
}
