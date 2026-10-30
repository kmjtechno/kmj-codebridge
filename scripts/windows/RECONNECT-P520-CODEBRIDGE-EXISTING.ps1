# KMJ TECHNO | P520 CodeBridge only. Default is read-only. -Apply reconnects.
# Does NOT pair, revoke, elevate, export credentials or modify another project.
[CmdletBinding()]
param([switch]$Apply,[switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$hostPin = 'DESKTOP-5FVJMET'
$devicePin = 'kmj-kmj-codebridge-desktop-5fvjmet'
$projectPin = 'kmj-codebridge'
$gatewayPin = 'https://kmjtechno.com'
$origins = @('https://github.com/kmjtechno/kmj-codebridge','https://github.com/kmjtechno/kmj-codebridge.git','git@github.com:kmjtechno/kmj-codebridge.git')
function Mark([string]$K,[string]$V) { Write-Output ($K+'='+$V) }
function Ordinary([string]$Path,[bool]$Directory) {
  if (![IO.Path]::IsPathRooted($Path)) { throw 'UNTRUSTED_PATH' }
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ([bool]$item.PSIsContainer -ne $Directory) { throw 'UNTRUSTED_PATH' }
  if (!$Directory -and $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UNTRUSTED_PATH' }
  $walk = if ($Directory) { $item } else { $item.Directory }
  while ($null -ne $walk) {
    if ($walk.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UNTRUSTED_PATH' }
    $walk = $walk.Parent
  }
}
function MatchesScope([string]$File) {
  if ([IO.Path]::GetFileName($File) -cne 'agent.json' -or $File -notmatch '(?i)[\\/]+private[\\/]+') { return $false }
  try {
    Ordinary $File $false
    $item = Get-Item -LiteralPath $File -ErrorAction Stop
    if ($item.Length -lt 32 -or $item.Length -gt 262144) { return $false }
    # Sensitive fields are parsed in local memory only; none are printed.
    $cfg = Get-Content -LiteralPath $File -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ([string]$cfg.id -cne $devicePin -or
      [string]$cfg.gateway -cnotin @($gatewayPin,($gatewayPin+'/')) -or
      [string]$cfg.tenant -notmatch '^[A-Za-z0-9_-]{1,64}$' -or
      ![IO.Path]::IsPathRooted([string]$cfg.stateDir) -or
      [string]$cfg.stateDir -notmatch '(?i)[\\/]+private[\\/]+') { return $false }
    $projects = @($cfg.projects)
    if ($projects.Count -lt 1 -or $projects.Count -gt 8) { return $false }
    $match = @($projects | Where-Object { [string]$_.id -ceq $projectPin -and [IO.Path]::IsPathRooted([string]$_.root) })
    return $match.Count -eq 1
  } catch { return $false }
}
function TrustedEntrypoint([string]$Root) {
  Ordinary $Root $true
  $git = (Get-Command git.exe -ErrorAction Stop).Source
  $origin = [string]((& $git -C $Root remote get-url origin 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $origin.Trim() -cnotin $origins) { throw 'UNTRUSTED_RUNTIME' }
  $top = [string]((& $git -C $Root rev-parse --show-toplevel 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($top).TrimEnd([char]92) -ine [IO.Path]::GetFullPath($Root).TrimEnd([char]92)) { throw 'UNTRUSTED_RUNTIME' }
  $dirty = @(& $git --no-optional-locks -C $Root status --porcelain=v1 --untracked-files=no 2>$null)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) { throw 'DIRTY_RUNTIME' }
  $rel = 'scripts/windows/ONE-CLICK-ANY-DEVICE.ps1'
  $entry = Join-Path $Root 'scripts\windows\ONE-CLICK-ANY-DEVICE.ps1'
  Ordinary $entry $false
  $blob = [string]((& $git -C $Root rev-parse ('HEAD:'+$rel) 2>$null) | Select-Object -First 1)
  $actual = [string]((& $git -C $Root hash-object -- $entry 2>$null) | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $blob -notmatch '^[a-f0-9]{40}$' -or $actual.Trim() -cne $blob.Trim()) { throw 'UNTRUSTED_ENTRYPOINT' }
  return $entry
}
try {
  if ($SelfTest) {
    if ($hostPin -cne 'DESKTOP-5FVJMET' -or $devicePin -cne 'kmj-kmj-codebridge-desktop-5fvjmet' -or $projectPin -cne 'kmj-codebridge') { throw 'PIN_INVALID' }
    Mark 'P520_CODEBRIDGE_SELFTEST' 'PASS'
    Mark 'AGENT_STARTED' 'NO'
    exit 0
  }
  if ($env:OS -cne 'Windows_NT' -or $env:COMPUTERNAME -ine $hostPin) { throw 'WRONG_WINDOWS_HOST' }
  Ordinary $PSCommandPath $false
  $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  $entry = TrustedEntrypoint $root
  $stores = @((Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\private'),'D:\KMJ-HyperSpeed\private','E:\KMJ\private','E:\KMJ\CodeBridge-HomeOffice\private')
  $hits = @{}
  foreach ($store in $stores) {
    if (!(Test-Path -LiteralPath $store -PathType Container)) { continue }
    try { Ordinary $store $true } catch { continue }
    $items = @(Get-ChildItem -LiteralPath $store -File -Filter 'agent.json' -Recurse -Depth 6 -ErrorAction SilentlyContinue | Select-Object -First 129)
    if ($items.Count -gt 128) { throw 'DISCOVERY_LIMIT' }
    foreach ($item in $items) {
      $full = [IO.Path]::GetFullPath($item.FullName)
      if (MatchesScope $full) { $hits[$full.ToLowerInvariant()] = $full }
    }
  }
  if ($hits.Count -eq 0) { throw 'NO_EXISTING_SCOPED_ENROLLMENT' }
  if ($hits.Count -ne 1) { throw 'AMBIGUOUS_ENROLLMENT' }
  Mark 'P520_CODEBRIDGE_SCOPE' 'EXACT_EXISTING_MATCH'
  Mark 'GATEWAY_READY' 'NOT_ATTESTED'
  if (!$Apply) { Mark 'P520_CODEBRIDGE_RECOVERY' 'CHECK_ONLY'; Mark 'AGENT_STARTED' 'NO'; exit 0 }
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Ordinary $ps $false
  $config = @($hits.Values)[0]
  # -ConfigPath is required: prevents the universal installer's new-pairing path.
  & $ps -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $entry -ConfigPath $config 2>$null | ForEach-Object {
    $line = [string]$_
    if ($line.Length -lt 140 -and $line -match '^KMJ_UNIVERSAL=[A-Z0-9_:]+$') { Write-Output $line }
  }
  if ($LASTEXITCODE -ne 0) { throw 'RECONNECT_NOT_VERIFIED' }
  Mark 'P520_CODEBRIDGE_RECOVERY' 'LOCAL_LAUNCHER_SUCCEEDED'
  Mark 'GATEWAY_READY' 'CHECK_ACCOUNT_SIDE'
  Mark 'NEW_PAIRING_STARTED' 'NO'
} catch {
  $reason = [string]$_.Exception.Message
  if ($reason -cnotmatch '^(UNTRUSTED_PATH|UNTRUSTED_RUNTIME|DIRTY_RUNTIME|UNTRUSTED_ENTRYPOINT|PIN_INVALID|WRONG_WINDOWS_HOST|DISCOVERY_LIMIT|NO_EXISTING_SCOPED_ENROLLMENT|AMBIGUOUS_ENROLLMENT|RECONNECT_NOT_VERIFIED)$') { $reason = 'LOCAL_PREFLIGHT_FAILED' }
  Mark 'P520_CODEBRIDGE_RECOVERY' ('BLOCKED_'+$reason)
  Mark 'NEW_PAIRING_STARTED' 'NO'
  Mark 'CREDENTIALS_EXPORTED' 'NO'
  exit 2
}
