# KMJ CodeBridge - one-click reconnect for the approved P720 device.
# Current-user only. No credential copies, new enrollments, task modifications,
# network listeners, source checkout edits, or agent replacement.
param([switch]$CheckOnly, [switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = 'D:\KMJ-HyperSpeed'
$sourceSha = '5334ebf83a4d2eac8135f6a4eb84a5f2d61f4674'
$release = Join-Path $root "codebridge-releases\$sourceSha"
$entry = Join-Path $release 'src\cli.js'
$project = Join-Path $root 'projects\kmj-codebridge'
$configPath = Join-Path $root 'private\p720-codebridge\agent.json'
$stateDir = Join-Path $root 'private\p720-codebridge\state'
$connectionFile = Join-Path $stateDir 'connection.json'
$gateway = 'https://kmjtechno.com'
$expectedDevice = ('kmj-p720-' + ($env:COMPUTERNAME -replace '[^A-Za-z0-9_-]', '-').ToLowerInvariant())
if ($expectedDevice.Length -gt 64) { $expectedDevice = $expectedDevice.Substring(0, 64) }

function RequireRegular([string]$value, [bool]$directory) {
    $item = Get-Item -LiteralPath $value -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne $directory -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'UNTRUSTED_DEVICE_PATH'
    }
}
function ApprovedScope($cfg) {
    if ($null -eq $cfg -or [string]$cfg.id -cne $expectedDevice -or
        @($cfg.projects).Count -ne 1 -or
        [string]$cfg.projects[0].id -cne 'kmj-codebridge' -or
        [string]$cfg.projects[0].root -ine $project -or
        [string]$cfg.stateDir -ine $stateDir -or
        [string]$cfg.gateway -cnotin @($gateway, ($gateway + '/')) -or
        [string]$cfg.tenant -eq '' -or
        [string]$cfg.token -notmatch '^.{32,8192}$') {
        return $false
    }
    return $true
}
function ScopedAgents {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
    return @($all | Where-Object {
        $_.CommandLine -and
        $_.CommandLine.IndexOf($configPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -match 'src[\\/]cli\.js' -and
        $_.CommandLine -match '\bagent\b'
    })
}
function LockOwner {
    $lock = Join-Path $stateDir 'agent.lock'
    if (!(Test-Path -LiteralPath $lock -PathType Leaf)) { return $null }
    RequireRegular $lock $false
    $raw = Get-Content -LiteralPath $lock -Raw -ErrorAction Stop
    if ($raw.Length -gt 2048) { throw 'INVALID_AGENT_LOCK' }
    if ($raw.Trim() -match '^[1-9][0-9]*$') { return [int]$raw.Trim() }
    $record = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $record -or [int]$record.pid -le 0) { throw 'INVALID_AGENT_LOCK' }
    return [int]$record.pid
}
function FreshConnection([datetime]$since) {
    if (!(Test-Path -LiteralPath $connectionFile -PathType Leaf)) { return $false }
    RequireRegular $connectionFile $false
    $data = Get-Content -LiteralPath $connectionFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace([string]$data.connectedAt)) { return $false }
    $stamp = [datetime]::Parse([string]$data.connectedAt).ToUniversalTime()
    $now = [datetime]::UtcNow
    return ($stamp -ge $since.AddSeconds(-2) -and $stamp -le $now.AddSeconds(10))
}
function AssertAnonymousGateway {
    # HTTP 401 is authentication enforcement, not an authorized device grant.
    try {
        $null = Invoke-WebRequest -Uri ($gateway + '/agent/health') -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 15 -MaximumRedirection 0 -UseBasicParsing
        throw 'ANONYMOUS_GATEWAY_NOT_PROTECTED'
    } catch [System.Net.WebException] {
        if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) {
            throw 'GATEWAY_UNREACHABLE_OR_NOT_PROTECTED'
        }
    }
}
try {
    if ($env:OS -cne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
    if ($SelfTest) {
        $valid = [pscustomobject]@{
            id = $expectedDevice; tenant = 'test'; token = ('x' * 32)
            gateway = $gateway; stateDir = $stateDir
            projects = @([pscustomobject]@{ id = 'kmj-codebridge'; root = $project })
        }
        if (!(ApprovedScope $valid)) { throw 'SELFTEST_SCOPE_FAILED' }
        $valid.gateway = 'https://example.invalid'
        if (ApprovedScope $valid) { throw 'SELFTEST_UNTRUSTED_GATEWAY_ACCEPTED' }
        Write-Output 'DEVICE_CONNECT_SELFTEST=PASS'
        exit 0
    }
    if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'PAIRING_REQUIRED_USE_OWNER_APPROVED_PAIRING_LAUNCHER'
    }
    foreach ($p in @($root, $release, $project, $stateDir)) { RequireRegular $p $true }
    foreach ($p in @($entry, $configPath)) { RequireRegular $p $false }
    $cfg = Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if (!(ApprovedScope $cfg)) { throw 'ENROLLMENT_SCOPE_MISMATCH' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    RequireRegular $node $false
    $nodeVersion = [string](& $node --version)
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
        throw 'NODE24_REQUIRED'
    }
    $null = Get-Command git.exe -ErrorAction Stop
    $head = [string]((& git.exe -C $release rev-parse --verify HEAD) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $head.Trim() -cne $sourceSha) { throw 'PINNED_RELEASE_SHA_MISMATCH' }
    $origin = [string]((& git.exe -C $release remote get-url origin) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $origin.Trim() -cnotin @(
        'https://github.com/kmjtechno/kmj-codebridge',
        'https://github.com/kmjtechno/kmj-codebridge.git',
        'git@github.com:kmjtechno/kmj-codebridge.git'
    )) { throw 'UNTRUSTED_SOURCE_REMOTE' }
    $changes = @(& git.exe --no-optional-locks -C $release status --porcelain=v1 --untracked-files=no)
    if ($LASTEXITCODE -ne 0 -or $changes.Count -ne 0) { throw 'PINNED_RELEASE_TRACKED_CHANGES' }
    if (!(Test-Path -LiteralPath (Join-Path $release 'node_modules\zod\package.json'))) {
        throw 'PINNED_RUNTIME_DEPENDENCIES_MISSING'
    }
    $agents = @(ScopedAgents)
    if ($agents.Count -gt 1) { throw 'DUPLICATE_ENROLLED_AGENTS' }
    $lockPid = LockOwner
    if ($agents.Count -eq 1) {
        if ($null -ne $lockPid -and $lockPid -ne [int]$agents[0].ProcessId) {
            throw 'AGENT_LOCK_OWNER_MISMATCH'
        }
        Write-Output 'DEVICE_CONNECT=ALREADY_RUNNING'
        Write-Output 'DUPLICATE_AGENT_STARTED=NO'
        Write-Output 'ACCOUNT_GRANT=VERIFY_IN_AUTHENTICATED_CODEBRIDGE_CLIENT'
        exit 0
    }
    if ($null -ne $lockPid -and $null -ne (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
        throw 'AGENT_LOCK_OWNER_ALIVE'
    }
    AssertAnonymousGateway
    Write-Output 'CONNECT_PREFLIGHT=PASS'
    if ($CheckOnly) {
        Write-Output 'DEVICE_CONNECT=DRY_RUN'
        Write-Output 'AGENT_STARTED=NO'
        exit 0
    }
    # Logs stay inside the owner-private state folder. The agent itself
    # proves a fresh authenticated connection; a local process is insufficient.
    $logId = [guid]::NewGuid().ToString('N')
    $out = Join-Path $stateDir ("device-connect-" + $logId + ".out.log")
    $err = Join-Path $stateDir ("device-connect-" + $logId + ".err.log")
    $started = [datetime]::UtcNow
    $proc = Start-Process -FilePath $node -ArgumentList @($entry, 'agent', $configPath) -WorkingDirectory $release -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    Write-Output 'AGENT_PROCESS_LAUNCHED=YES'
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Seconds 2
        $proc.Refresh()
        if ($proc.HasExited) { throw 'AGENT_EXITED_BEFORE_HEARTBEAT' }
        $current = @(ScopedAgents)
        if ($current.Count -ne 1 -or [int]$current[0].ProcessId -ne $proc.Id) {
            throw 'SCOPED_AGENT_RACE_DETECTED'
        }
        try {
            if (FreshConnection $started) {
                Write-Output 'DEVICE_CONNECT=LOCAL_AUTHENTICATED_HEARTBEAT'
                Write-Output 'ENROLLMENT=UNCHANGED'
                Write-Output 'DIRTY_CHECKOUT=UNTOUCHED'
                Write-Output 'ACCOUNT_GRANT=VERIFY_IN_AUTHENTICATED_CODEBRIDGE_CLIENT'
                exit 0
            }
        } catch {
            # Malformed/stale heartbeat cannot claim success.
        }
    }
    throw 'FRESH_GATEWAY_HEARTBEAT_NOT_VERIFIED'
} catch {
    $message = [string]$_.Exception.Message
    if ($message -notmatch '^[A-Z][A-Z0-9_]{2,100}$') { $message = 'LOCAL_PRECONDITION_OR_RUNTIME_ERROR' }
    Write-Output ('DEVICE_CONNECT=BLOCKED:' + $message)
    Write-Output 'ENROLLMENT=UNCHANGED'
    Write-Output 'DIRTY_CHECKOUT=UNTOUCHED'
    Write-Output 'REMEDIATION=KEEP_CURRENT_AGENT_AND_INSPECT_LOCAL_STATE'
    exit 2
}
