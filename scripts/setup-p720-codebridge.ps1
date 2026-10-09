# KMJ P720 temporary, one-project CodeBridge agent. No administrator rights.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = 'D:\KMJ-HyperSpeed'
$project = Join-Path $root 'projects\kmj-codebridge'
$private = Join-Path $root 'private\p720-codebridge'
$state = Join-Path $private 'state'
$enrollment = Join-Path $private 'enrollment.json'
$configFile = Join-Path $private 'agent.json'
$logFolder = Join-Path $root 'logs'
$statusFile = Join-Path $root 'P720-CODEBRIDGE-STATUS.txt'
$projectId = 'kmj-codebridge'
$deviceId = 'kmj-p720-' + ($env:COMPUTERNAME -replace '[^A-Za-z0-9_-]', '-').ToLowerInvariant()
if ($deviceId.Length -gt 64) { $deviceId = $deviceId.Substring(0, 64) }

function Status([string]$kind, [string]$message) {
    $line = '{0}: {1}' -f $kind, $message
    Write-Host $line
    Add-Content -LiteralPath $statusFile -Value $line -Encoding UTF8
}
function Protect-Folder([string]$folder) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $grant = '*' + $sid + ':(OI)(CI)F'
    & icacls.exe $folder /inheritance:r /grant:r $grant | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private folder ACL could not be enforced.' }
}
function Protect-File([string]$file) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $grant = '*' + $sid + ':F'
    & icacls.exe $file /inheritance:r /grant:r $grant | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private credential ACL could not be enforced.' }
}
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Windows-only setup.' }
    if (!(Test-Path -LiteralPath 'D:\')) { throw 'D: drive missing.' }
    New-Item -ItemType Directory -Path $root, $logFolder -Force | Out-Null
    Set-Content -LiteralPath $statusFile -Value 'KMJ P720 CodeBridge setup - REPORT HAS NO CREDENTIALS' -Encoding UTF8
    Status 'INFO' 'Free one-project mode; no paid APIs, runner, production changes or arbitrary shell.'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $v = (& $node --version).Trim()
    if ([int]($v -replace '^v([0-9]+).*$', '$1') -lt 24) { throw 'Node 24+ required.' }
    if (!(Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'Git required.' }
    if (!(Test-Path -LiteralPath (Join-Path $project '.git'))) { throw 'D: CodeBridge checkout not found.' }
    if ((Get-Item -LiteralPath $project).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse-point project root rejected.' }
    $origin = (& git -C $project remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or $origin -notmatch '^(https://github\.com/kmjtechno/kmj-codebridge(\.git)?|git@github\.com:kmjtechno/kmj-codebridge\.git)$') { throw 'Unexpected repository origin.' }
    if ((& git -C $project branch --show-current).Trim() -ne 'main') { throw 'Use clean main branch; no reset performed.' }
    $dirty = @(& git -C $project status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Checkout dirty; no files reset or overwritten.' }
    Status 'PASS' ('Existing trusted project ready; Node ' + $v)
    if (!(Test-Path -LiteralPath (Join-Path $project 'node_modules\zod\package.json'))) {
        & npm.cmd --prefix $project ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    New-Item -ItemType Directory -Path $private, $state -Force | Out-Null
    Protect-Folder $private
    Protect-Folder $state

    if (!(Test-Path -LiteralPath $configFile)) {
        if (!(Test-Path -LiteralPath $enrollment)) {
            Status 'INFO' ('Requesting approval for device ' + $deviceId + ' and project ' + $projectId)
            Write-Host 'Open the HTTPS pairing URL below; sign in to KMJ and approve the shown read/write/execute project scope.'
            & $node (Join-Path $project 'scripts\enroll-device.js') 'https://kmjtechno.com' $deviceId $projectId $project $enrollment
            if ($LASTEXITCODE -ne 0) { throw 'Browser pairing failed or expired (no agent started).' }
        }
        Protect-File $enrollment
        $grant = Get-Content -LiteralPath $enrollment -Raw | ConvertFrom-Json
        $gateway = [string]$grant.gateway
        # The Main Platform enrollment API may omit 'gateway' (legacy contract).
        # Match the verified default in scripts/install-vps.sh; never use /mcp.
        if ([string]::IsNullOrWhiteSpace($gateway)) {
            $gateway = 'https://kmj-codebridge-gateway.onrender.com'
            Status 'INFO' 'Enrollment omitted gateway; using the canonical published CodeBridge agent origin.'
        }
        if ($gateway -notmatch '^https://[A-Za-z0-9.-]+(?::443)?/?
        if ($grant.agent.id -ne $deviceId -or @($grant.projects | Where-Object { $_.id -eq $projectId }).Count -ne 1) { throw 'Enrollment device/project binding mismatch.' }
        foreach ($p in @('read', 'write', 'execute')) {
            if ($grant.permissions -notcontains $p) { throw 'Enrollment does not include required permission grant.' }
        }
        $cfg = @{
            gateway = $gateway.TrimEnd('/') + '/'
            token = [string]$grant.agent.token
            id = [string]$grant.agent.id
            tenant = [string]$grant.agent.tenant
            stateDir = $state
            projects = @(@{
                id = $projectId
                root = $project
                writable = $true
                gates = @{
                    check = @{ command = 'node'; args = @('scripts/check.js'); timeoutMs = 120000 }
                    p720_ai_tests = @{ command = 'node'; args = @('--test', 'tests/p720-ai-check.test.js'); timeoutMs = 120000 }
                    scan_secrets = @{ command = 'node'; args = @('scripts/scan-secrets.js'); timeoutMs = 120000 }
                }
            })
            license = @{ mode = 'free' }
        }
        [IO.File]::WriteAllText($configFile, ($cfg | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
        Protect-File $configFile
        Status 'PASS' 'Scoped agent credentials stored in private D: folder.'
    } else {
        Protect-File $configFile
        $existing = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
        if ($existing.id -ne $deviceId -or @($existing.projects).Count -ne 1 -or $existing.projects[0].id -ne $projectId -or $existing.projects[0].root -ne $project) {
            throw 'Existing config differs from expected project scope; refusing overwrite.'
        }
        Status 'PASS' 'Existing scoped credential reused.'
    }
    $connection = Join-Path $state 'connection.json'
    $started = [DateTime]::UtcNow
    $p = Start-Process -FilePath $node -ArgumentList @('src/cli.js', 'agent', $configFile) -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logFolder 'p720-agent-out.log') -RedirectStandardError (Join-Path $logFolder 'p720-agent-err.log') -PassThru
    Status 'INFO' ('Agent started PID ' + $p.Id)
    $online = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 2
        $p.Refresh()
        if ($p.HasExited) { throw 'Agent stopped; see p720-agent-err.log (do not upload private config).' }
        if (Test-Path -LiteralPath $connection) {
            try {
                $stamp = [DateTime]::Parse((Get-Content -LiteralPath $connection -Raw | ConvertFrom-Json).connectedAt).ToUniversalTime()
                if ($stamp -ge $started.AddSeconds(-2)) { $online = $true; break }
            } catch { }
        }
    }
    if ($online) { Status 'PASS' 'Gateway heartbeat connected; account grant must still be checked.' }
    else { Status 'WARN' 'Agent running but gateway heartbeat not verified yet.' }
    Status 'NEXT' 'Ask CodeBridge connection_overview to confirm account grants for this P720.'
    Status 'NEXT' 'Upload only P720-CODEBRIDGE-STATUS.txt; never agent.json or enrollment.json.'
} catch {
    if (Test-Path -LiteralPath $statusFile) { Status 'BLOCKED' ([string]$_.Exception.Message) }
    else { Write-Host ('BLOCKED: ' + $_.Exception.Message) }
    exit 2
}
) { throw 'Approved enrollment gateway must be a canonical HTTPS origin.' }
        $gateway = $gateway.TrimEnd('/')
        try {
            $health = Invoke-WebRequest -Uri ($gateway + '/healthz') -Method Get -TimeoutSec 15 -MaximumRedirection 0 -UseBasicParsing
            if ([int]$health.StatusCode -ne 200) { throw 'Unhealthy gateway response.' }
        } catch {
            throw 'Approved CodeBridge agent gateway health check failed; retained existing enrollment for retry.'
        }
        Status 'PASS' 'Official CodeBridge agent gateway is reachable over HTTPS.'
        if ($grant.agent.id -ne $deviceId -or @($grant.projects | Where-Object { $_.id -eq $projectId }).Count -ne 1) { throw 'Enrollment device/project binding mismatch.' }
        foreach ($p in @('read', 'write', 'execute')) {
            if ($grant.permissions -notcontains $p) { throw 'Enrollment does not include required permission grant.' }
        }
        $cfg = @{
            gateway = $gateway.TrimEnd('/') + '/'
            token = [string]$grant.agent.token
            id = [string]$grant.agent.id
            tenant = [string]$grant.agent.tenant
            stateDir = $state
            projects = @(@{
                id = $projectId
                root = $project
                writable = $true
                gates = @{
                    check = @{ command = 'node'; args = @('scripts/check.js'); timeoutMs = 120000 }
                    p720_ai_tests = @{ command = 'node'; args = @('--test', 'tests/p720-ai-check.test.js'); timeoutMs = 120000 }
                    scan_secrets = @{ command = 'node'; args = @('scripts/scan-secrets.js'); timeoutMs = 120000 }
                }
            })
            license = @{ mode = 'free' }
        }
        [IO.File]::WriteAllText($configFile, ($cfg | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
        Protect-File $configFile
        Status 'PASS' 'Scoped agent credentials stored in private D: folder.'
    } else {
        Protect-File $configFile
        $existing = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
        if ($existing.id -ne $deviceId -or @($existing.projects).Count -ne 1 -or $existing.projects[0].id -ne $projectId -or $existing.projects[0].root -ne $project) {
            throw 'Existing config differs from expected project scope; refusing overwrite.'
        }
        Status 'PASS' 'Existing scoped credential reused.'
    }
    $connection = Join-Path $state 'connection.json'
    $started = [DateTime]::UtcNow
    $p = Start-Process -FilePath $node -ArgumentList @('src/cli.js', 'agent', $configFile) -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logFolder 'p720-agent-out.log') -RedirectStandardError (Join-Path $logFolder 'p720-agent-err.log') -PassThru
    Status 'INFO' ('Agent started PID ' + $p.Id)
    $online = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 2
        $p.Refresh()
        if ($p.HasExited) { throw 'Agent stopped; see p720-agent-err.log (do not upload private config).' }
        if (Test-Path -LiteralPath $connection) {
            try {
                $stamp = [DateTime]::Parse((Get-Content -LiteralPath $connection -Raw | ConvertFrom-Json).connectedAt).ToUniversalTime()
                if ($stamp -ge $started.AddSeconds(-2)) { $online = $true; break }
            } catch { }
        }
    }
    if ($online) { Status 'PASS' 'Gateway heartbeat connected; account grant must still be checked.' }
    else { Status 'WARN' 'Agent running but gateway heartbeat not verified yet.' }
    Status 'NEXT' 'Ask CodeBridge connection_overview to confirm account grants for this P720.'
    Status 'NEXT' 'Upload only P720-CODEBRIDGE-STATUS.txt; never agent.json or enrollment.json.'
} catch {
    if (Test-Path -LiteralPath $statusFile) { Status 'BLOCKED' ([string]$_.Exception.Message) }
    else { Write-Host ('BLOCKED: ' + $_.Exception.Message) }
    exit 2
}
