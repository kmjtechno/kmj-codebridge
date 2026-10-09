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
function Confirm-VpsGateway {
    try {
        Invoke-WebRequest -Uri 'https://kmjtechno.com/agent/health' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 15 -MaximumRedirection 0 -UseBasicParsing | Out-Null
        throw 'VPS agent gateway unexpectedly accepted an unauthenticated request.'
    } catch [System.Net.WebException] {
        if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) {
            throw 'VPS agent gateway did not return expected HTTP 401. Setup stopped safely.'
        }
    }
    Status 'PASS' 'Verified VPS agent route requires authentication (HTTP 401 without token).'
}
function Find-ScopedAgent {
    $matches = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($configFile) -and
        $_.CommandLine -match 'src[\\/]cli\.js' -and $_.CommandLine -match '\bagent\b'
    })
    if ($matches.Count -gt 1) { throw 'Multiple P720 agent processes found; refusing automatic process changes.' }
    return $matches
}
function Stop-ScopedAgent {
    $running = @(Find-ScopedAgent)
    if ($running.Count -eq 0) { return }
    $pidToStop = [int]$running[0].ProcessId
    Stop-Process -Id $pidToStop -ErrorAction Stop
    Start-Sleep -Seconds 2
    if (Get-Process -Id $pidToStop -ErrorAction SilentlyContinue) {
        throw 'Existing scoped agent did not stop; refusing config update.'
    }
    Status 'INFO' 'Stopped only the previous scoped P720 agent before gateway migration.'
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
        $returnedGateway = [string]$grant.gateway
        # Never route the user-controlled credential to an unknown endpoint.
        # The old optional enrollment field and Render fallback are supported only
        # as legacy metadata. The signed-in ChatGPT gateway actually runs on VPS.
        if (![string]::IsNullOrWhiteSpace($returnedGateway) -and
            $returnedGateway.TrimEnd('/') -notin @('https://kmjtechno.com', 'https://kmj-codebridge-gateway.onrender.com')) {
            throw 'Enrollment returned an unexpected agent gateway; refusing secret forwarding.'
        }
        Confirm-VpsGateway
        $gateway = 'https://kmjtechno.com'
        Status 'INFO' 'Using canonical KMJ VPS agent origin for account-visible device registration.'
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
                    p720_inference = @{ command = 'node'; args = @('scripts/p720-ai-check.mjs'); timeoutMs = 240000 }
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
        if ($existing.license.mode -ne 'free' -or [string]$existing.stateDir -ne $state -or
            [string]$existing.token -eq '' -or [string]$existing.tenant -eq '') {
            throw 'Existing agent scope or credential invalid; refusing migration.'
        }
        if ([string]$existing.gateway -notin @('https://kmjtechno.com/', 'https://kmjtechno.com',
                'https://kmj-codebridge-gateway.onrender.com/', 'https://kmj-codebridge-gateway.onrender.com')) {
            throw 'Unexpected stored gateway origin; refusing migration.'
        }
        Confirm-VpsGateway
        $running = @(Find-ScopedAgent)
        if ([string]$existing.gateway -in @('https://kmjtechno.com/', 'https://kmjtechno.com') -and
            $running.Count -eq 1) {
            Status 'PASS' 'Scoped P720 agent already running against the VPS; no duplicate started.'
            Status 'NEXT' 'Ask CodeBridge connection_overview to verify the new device grant.'
            return
        }
        Stop-ScopedAgent
        if ([string]$existing.gateway -notin @('https://kmjtechno.com/', 'https://kmjtechno.com')) {
            $backup = $configFile + '.before-vps-routing.bak'
            if (!(Test-Path -LiteralPath $backup)) {
                Copy-Item -LiteralPath $configFile -Destination $backup -ErrorAction Stop
                Protect-File $backup
            }
            $existing.gateway = 'https://kmjtechno.com/'
            if ($existing.projects[0].gates.PSObject.Properties.Name -notcontains 'p720_inference') {
                $existing.projects[0].gates | Add-Member -NotePropertyName p720_inference -NotePropertyValue @{
                    command = 'node'; args = @('scripts/p720-ai-check.mjs'); timeoutMs = 240000
                }
            }
            $tempConfig = $configFile + '.migrate'
            if (Test-Path -LiteralPath $tempConfig) {
                # The previous PowerShell/.NET File.Replace(null backup) failure left
                # a private, not-yet-swapped temp file. Verify exact identity and
                # secret equality before removing only that known temporary copy.
                $stale = Get-Content -LiteralPath $tempConfig -Raw | ConvertFrom-Json
                if ([string]$stale.id -cne [string]$existing.id -or
                    [string]$stale.tenant -cne [string]$existing.tenant -or
                    [string]$stale.token -cne [string]$existing.token -or
                    [string]$stale.gateway -ne 'https://kmjtechno.com/' -or
                    @($stale.projects).Count -ne 1 -or
                    [string]$stale.projects[0].id -ne $projectId -or
                    [string]$stale.projects[0].root -ne $project -or
                    [string]$stale.stateDir -ne $state) {
                    throw 'Stale private migration file differs from approved scope; refusing overwrite.'
                }
                Remove-Item -LiteralPath $tempConfig -Force -ErrorAction Stop
                Status 'INFO' 'Verified and cleared the prior failed migration temp file.'
            }
            [IO.File]::WriteAllText($tempConfig, ($existing | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
            Protect-File $tempConfig
            # Windows PowerShell's .NET File.Replace requires a valid backup
            # filename. Never pass $null; keep the original secure backup intact.
            $swapBackup = $configFile + '.swap-' + [guid]::NewGuid().ToString('N') + '.bak'
            [IO.File]::Replace($tempConfig, $configFile, $swapBackup)
            Protect-File $swapBackup
            Status 'PASS' 'Existing credential migrated atomically to VPS origin; private backup retained.'
        } else {
            Status 'PASS' 'Existing VPS-bound credential reused.'
        }
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
