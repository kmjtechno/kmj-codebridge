<#
.SYNOPSIS
  One-shot credential-free LOCAL SERVICE task-context canary for P720.
.DESCRIPTION
  Runs only under NT AUTHORITY\LOCAL SERVICE and never starts an agent.
  Reads zero token bytes; checks file-open permissions and outbound TLS only.
  Does not edit an existing Scheduled Task, registry, code or credentials.
  Exit 0 proves ONLY LocalService file readability and public HTTPS reachability.
  It does NOT prove authenticated CodeBridge enrollment or takeover readiness.
#>
[CmdletBinding()]
param([switch]$SelfTest, [switch]$RunAsTask)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Private = 'D:\KMJ-HyperSpeed\private\p720-codebridge'
$Config = Join-Path $Private 'agent.json'
$Token = Join-Path $Private 'supervisor.token'
$Lock = Join-Path $Private 'state\agent.lock'
$GatewayOrigin = 'https://kmjtechno.com/'
$LocalServiceSid = 'S-1-5-19'

function FileReadableWithoutContents([string]$Path) {
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $item.Length -le 0) {
    return $false
  }
  $stream = $null
  try {
    $stream = [IO.File]::Open(
      $Path,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::ReadWrite
    )
    return $stream.Length -gt 0
  } catch {
    return $false
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function PublicHttpsReachable {
  $request = [Net.HttpWebRequest][Net.WebRequest]::Create($GatewayOrigin)
  $request.Method = 'HEAD'
  $request.AllowAutoRedirect = $false
  $request.Timeout = 12000
  $request.ReadWriteTimeout = 12000
  $request.UseDefaultCredentials = $false
  $request.Credentials = $null
  $response = $null
  try {
    $response = [Net.HttpWebResponse]$request.GetResponse()
    return ([int]$response.StatusCode -ge 200 -and
            [int]$response.StatusCode -lt 500)
  } catch [Net.WebException] {
    # A completed TLS request with an HTTP rejection still proves network
    # reachability; connection or certificate errors do not.
    $response = $_.Exception.Response
    return ($null -ne $response -and
            [int]$response.StatusCode -ge 200 -and
            [int]$response.StatusCode -lt 500)
  } catch {
    return $false
  } finally {
    if ($null -ne $response) { $response.Dispose() }
  }
}

Write-Output 'KMJ_P720_SERVICE_CANARY=READ_ONLY'
Write-Output 'KMJ_P720_SERVICE_CANARY_AGENT_STARTED=NO'
Write-Output 'KMJ_P720_SERVICE_CANARY_SECRETS=HIDDEN'
Write-Output 'KMJ_P720_SERVICE_CANARY_AUTHENTICATED_GATEWAY=UNPROVEN'
Write-Output 'KMJ_P720_SERVICE_CANARY_TAKEOVER=NOT_AUTHORIZED'

if ($SelfTest) {
  if ($RunAsTask -or
      $LocalServiceSid -cne 'S-1-5-19' -or
      $GatewayOrigin -cne 'https://kmjtechno.com/') {
    Write-Output 'KMJ_P720_SERVICE_CANARY_SELFTEST=FAIL'
    exit 31
  }
  Write-Output 'KMJ_P720_SERVICE_CANARY_SELFTEST=PASS'
  exit 0
}

if (-not $RunAsTask -or $env:OS -ne 'Windows_NT') {
  Write-Output 'KMJ_P720_SERVICE_CANARY_BLOCKER=FIXED_TASK_CONTEXT_REQUIRED'
  exit 21
}

try {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($sid -cne $LocalServiceSid) {
    Write-Output 'KMJ_P720_SERVICE_CANARY_BLOCKER=LOCALSERVICE_SID_REQUIRED'
    exit 22
  }

  if (-not (FileReadableWithoutContents $Config)) {
    Write-Output 'KMJ_P720_SERVICE_CANARY_BLOCKER=AGENT_CONFIG_NOT_READABLE'
    exit 23
  }
  if (-not (FileReadableWithoutContents $Token)) {
    Write-Output 'KMJ_P720_SERVICE_CANARY_BLOCKER=SUPERVISOR_TOKEN_NOT_READABLE'
    exit 24
  }
  if (-not (FileReadableWithoutContents $Lock)) {
    Write-Output 'KMJ_P720_SERVICE_CANARY_BLOCKER=AGENT_LOCK_NOT_READABLE'
    exit 25
  }

  if (-not (PublicHttpsReachable)) {
    Write-Output 'KMJ_P720_SERVICE_CANARY_BLOCKER=PUBLIC_GATEWAY_HTTPS_UNREACHABLE'
    exit 26
  }

  Write-Output 'KMJ_P720_SERVICE_CANARY_FILE_READ=PASS'
  Write-Output 'KMJ_P720_SERVICE_CANARY_PUBLIC_HTTPS=PASS'
  Write-Output 'KMJ_P720_SERVICE_CANARY=PASS_LIMITED'
  # Exit zero is NOT license to enable the disabled real agent task.
  exit 0
} catch {
  Write-Output 'KMJ_P720_SERVICE_CANARY_BLOCKER=UNCLASSIFIED'
  exit 27
}
