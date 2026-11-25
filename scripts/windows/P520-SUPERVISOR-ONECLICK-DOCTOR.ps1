# P520 read-only native Supervisor task + authenticated hardware check.
# No task start/stop, new listener, credential output or configuration mutation.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskName = 'KMJ-CodeBridge-Supervisor-P520'
$root = 'C:\ProgramData\KMJ-CodeBridge\P520'
$pipeName = 'kmj-codebridge-supervisor-p520'
$tokenFile = Join-Path $root 'supervisor.token'
$configFile = Join-Path $root 'supervisor.json'

function Need([bool]$Condition, [string]$Code) {
  if (-not $Condition) { throw $Code }
}

function Read-BoundedLine($Reader) {
  $pending = $Reader.ReadLineAsync()
  Need ($pending.Wait(4000)) 'PIPE_RESPONSE_TIMEOUT'
  $line = $pending.Result
  Need ($null -ne $line -and $line.Length -le 8192) 'PIPE_RESPONSE_INVALID'
  return $line
}

function Invoke-Probe([string]$Token, [bool]$Authenticated, [string]$Request) {
  $pipe = $null
  $reader = $null
  $writer = $null
  $hmac = $null
  try {
    $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $pipeName, [IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(4000)
    $utf8 = New-Object Text.UTF8Encoding($false)
    $reader = New-Object IO.StreamReader($pipe, $utf8)
    $writer = New-Object IO.StreamWriter($pipe, $utf8)
    $writer.NewLine = [string][char]10
    $writer.AutoFlush = $true
    $challenge = Read-BoundedLine $reader | ConvertFrom-Json
    Need ([string]$challenge.nonce -cmatch '^[0-9a-f]{32}$') 'PIPE_NONCE_INVALID'
    $mac = '0' * 64
    if ($Authenticated) {
      $hmac = New-Object Security.Cryptography.HMACSHA256
      $hmac.Key = $utf8.GetBytes($Token)
      $mac = [BitConverter]::ToString($hmac.ComputeHash($utf8.GetBytes($challenge.nonce + [char]10 + $Request))).Replace('-', '').ToLowerInvariant()
    }
    $writer.WriteLine('{"request":' + $Request + ',"mac":"' + $mac + '"}')
    return (Read-BoundedLine $reader | ConvertFrom-Json)
  } finally {
    if ($null -ne $pipe) { $pipe.Dispose() }
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $writer) { try { $writer.Dispose() } catch {} }
    if ($null -ne $hmac) { $hmac.Dispose() }
  }
}

try {
  $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
  Need (@($task).Count -eq 1) 'TASK_IDENTITY_INVALID'
  Need ([string]$task.State -eq 'Running') 'SUPERVISOR_TASK_NOT_RUNNING'
  Write-Output 'P520_SUPERVISOR_TASK=RUNNING'
  foreach ($p in @($root, $configFile, $tokenFile)) {
    $item = Get-Item -LiteralPath $p -Force
    Need (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'SUPERVISOR_REPARSE_POINT_DENIED'
  }
  $cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
  Need ([string]$cfg.pipeName -ceq $pipeName) 'PIPE_CONFIG_MISMATCH'
  Need ([IO.Path]::GetFullPath([string]$cfg.tokenFile) -ieq $tokenFile) 'TOKEN_PATH_MISMATCH'
  Need ((Get-Acl -LiteralPath $tokenFile).AreAccessRulesProtected) 'TOKEN_ACL_NOT_PROTECTED'
  Need ((Get-Item -LiteralPath $tokenFile).Length -le 4096) 'TOKEN_SIZE_INVALID'
  $token = [IO.File]::ReadAllText($tokenFile).Trim()
  Need ($token.Length -ge 32) 'TOKEN_SIZE_INVALID'
  $statusRequest = '{"op":"status","service":"agent"}'
  $negative = Invoke-Probe $token $false $statusRequest
  Need ($negative.ok -eq $false -and $negative.error -ceq 'SUPERVISOR_UNAUTHENTICATED') 'NEGATIVE_HMAC_CHECK_FAILED'
  $status = Invoke-Probe $token $true $statusRequest
  Need ($status.ok -eq $true -and $status.result.supervisor -ceq 'windows-native') 'AUTHENTICATED_STATUS_FAILED'
  Write-Output 'P520_HMAC_STATUS=PASS'
  $device = Invoke-Probe $token $true '{"op":"device_status"}'
  Need ($device.ok -eq $true -and [int]$device.result.cpuCount -gt 0) 'HARDWARE_STATUS_FAILED'
  Write-Output ('P520_CPU_COUNT=' + [int]$device.result.cpuCount)
  Write-Output 'P520_HARDWARE_RPC=PASS_LOCAL_ONLY'
  Write-Output 'P520_SETUP=REMOTE_AGENT_READBACK_REQUIRED'
} catch {
  $reason = [string]$_.Exception.Message
  if ($reason -cnotmatch '^[A-Z][A-Z0-9_]{3,90}$') { $reason = 'REVIEW_REQUIRED' }
  Write-Output ('P520_SETUP_BLOCKER=' + $reason)
  exit 2
} finally {
  Remove-Variable token -ErrorAction SilentlyContinue
}
