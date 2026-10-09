# KMJ P720 CineCore - independently authorized, free, single-project CodeBridge worker
# Never reuse the KMJ CodeBridge project's original credential for CineCore.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = 'D:\KMJ-HyperSpeed'
$codebridge = Join-Path $root 'projects\kmj-codebridge'
$cinecore = Join-Path $root 'projects\kmj-cinecore'
$private = Join-Path $root 'private\p720-cinecore'
$state = Join-Path $private 'state'
$enrollment = Join-Path $private 'enrollment.json'
$config = Join-Path $private 'agent.json'
$report = Join-Path $root 'P720-CINECORE-AUTH-RESULT.txt'
$logs = Join-Path $root 'logs'
$projectId = 'kmj-cinecore'
$deviceId = 'kmj-p720-cinecore-' + ($env:COMPUTERNAME -replace '[^A-Za-z0-9_-]', '-').ToLowerInvariant()
if ($deviceId.Length -gt 64) { $deviceId = $deviceId.Substring(0, 64) }

function Status([string]$kind, [string]$message) {
    $line = '{0}: {1}' -f $kind, $message
    Write-Host $line
    Add-Content -LiteralPath $report -Value $line -Encoding UTF8
}
function Protect-Folder([string]$folder) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $folder /inheritance:r /grant:r ('*' + $sid + ':(OI)(CI)F') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private folder ACL failed.' }
}
function Protect-File([string]$file) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $file /inheritance:r /grant:r ('*' + $sid + ':F') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private credential file ACL failed.' }
}
function Verify-Origin([string]$folder, [string]$expected) {
    if (!(Test-Path -LiteralPath (Join-Path $folder '.git'))) {
        throw ('Missing Git checkout: ' + $folder)
    }
    if ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Symlink/junction project roots are not authorized.'
    }
    $origin = @(& git -C $folder remote get-url origin)
    if ($LASTEXITCODE -ne 0 -or $origin.Count -ne 1) { throw 'Cannot verify repository origin.' }
    $canonical = $origin[0].Trim()
    if ($canonical -cne ('https://github.com/kmjtechno/' + $expected + '.git') -and
        $canonical -cne ('https://github.com/kmjtechno/' + $expected) -and
        $canonical -cne ('git@github.com:kmjtechno/' + $expected + '.git')) {
        throw ('Unexpected Git origin for ' + $expected)
    }
}
function Test-VpsGateway {
    try {
        Invoke-WebRequest -Uri 'https://kmjtechno.com/agent/health' -Method Post -ContentType 'application/json' -Body '{}' -MaximumRedirection 0 -TimeoutSec 15 -UseBasicParsing | Out-Null
        throw 'Agent gateway accepted unauthenticated probe unexpectedly.'
    } catch [System.Net.WebException] {
        if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) {
            throw 'VPS CodeBridge agent route must return HTTP 401 for an anonymous request.'
        }
    }
    Status 'PASS' 'VPS agent gateway HTTPS/authentication probe HTTP 401.'
}
function Find-CineCoreAgent {
    return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($config) -and
        $_.CommandLine -match 'src[\\/]cli\.js' -and $_.CommandLine -match '\bagent\b'
    })
}
function Configure-ClaudeMcp {
    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if ($null -eq $claude) {
        Status 'WARN' 'Claude Code CLI not found. Install/sign in separately, then connect the MCP using the documented command.'
        return
    }
    Push-Location -LiteralPath $cinecore
    $originalPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $claude.Source mcp get kmj-codebridge-cinecore *> $null
        if ($LASTEXITCODE -eq 0) {
            Status 'PASS' 'Existing CineCore-local Claude Code MCP entry detected; inspect /mcp to authenticate.'
        } else {
            & $claude.Source mcp add --transport http --scope local kmj-codebridge-cinecore https://kmjtechno.com/mcp *> $null
            if ($LASTEXITCODE -ne 0) { throw 'Claude MCP registration returned nonzero exit status.' }
            Status 'PASS' 'Claude Code local MCP entry created for KMJ CineCore (OAuth sign-in still required).'
        }
    } catch {
        Status 'WARN' 'Claude Code MCP registration needs manual user login or CLI setup; CodeBridge agent pairing is unaffected.'
    } finally {
        $ErrorActionPreference = $originalPreference
        Pop-Location
    }
}
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Windows 10/11 required.' }
    if (!(Test-Path -LiteralPath 'D:\')) { throw 'D: workspace missing.' }
    New-Item -ItemType Directory -Path $root, $logs -Force | Out-Null
    Set-Content -LiteralPath $report -Value 'KMJ P720 CINECORE - FRESH DEVICE AUTHORIZATION (NO PRIVATE CREDENTIALS)' -Encoding UTF8
    Status 'INFO' ('RUN_UTC=' + [DateTime]::UtcNow.ToString('o'))
    Status 'INFO' ('DEVICE_ID=' + $deviceId)
    Status 'INFO' ('PROJECT_ID=' + $projectId)
    Status 'INFO' 'One CineCore project only. Existing CodeBridge device and private tokens untouched.'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $v = (& $node --version).Trim()
    if ([int]($v -replace '^v([0-9]+).*$', '$1') -lt 24) { throw 'Node 24+ required.' }
    if (!(Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'Git required.' }
    Verify-Origin $codebridge 'kmj-codebridge'
    Verify-Origin $cinecore 'kmj-cinecore'
    $head = (& git -C $cinecore rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[a-f0-9]{40}$') { throw 'CineCore revision unavailable.' }
    Status 'PASS' ('CineCore checkout authorized at ' + $head)
    if (!(Test-Path -LiteralPath (Join-Path $codebridge 'node_modules\zod\package.json'))) {
        & npm.cmd --prefix $codebridge ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'CodeBridge locked dependencies could not be installed.' }
    }
    Test-VpsGateway
    New-Item -ItemType Directory -Path $private, $state -Force | Out-Null
    Protect-Folder $private
    Protect-Folder $state

    if (!(Test-Path -LiteralPath $config)) {
        if (!(Test-Path -LiteralPath $enrollment)) {
            Status 'INFO' 'Browser approval required for the NEW, distinct CineCore project grant.'
            Write-Host 'Approve kmj-cinecore read/write/execute in the signed-in KMJ account; do not approve a different project.'
            & $node (Join-Path $codebridge 'scripts\enroll-device.js') 'https://kmjtechno.com' $deviceId $projectId $cinecore $enrollment
            if ($LASTEXITCODE -ne 0) { throw 'CineCore pairing rejected, expired or blocked by license device limit.' }
        }
        Protect-File $enrollment
        $grant = Get-Content -LiteralPath $enrollment -Raw | ConvertFrom-Json
        if ([string]$grant.agent.id -cne $deviceId -or
            [string]$grant.agent.tenant -eq '' -or [string]$grant.agent.token -eq '' -or
            @($grant.projects).Count -ne 1 -or [string]$grant.projects[0].id -cne $projectId) {
            throw 'CineCore pairing identity/project grant did not match exactly.'
        }
        foreach ($permission in @('read', 'write', 'execute')) {
            if (@($grant.permissions) -cnotcontains $permission) { throw 'CineCore grant is missing required permission.' }
        }
        $returned = [string]$grant.gateway
        if ($returned -ne '' -and $returned.TrimEnd('/') -notin @(
            'https://kmjtechno.com', 'https://kmj-codebridge-gateway.onrender.com')) {
            throw 'Unexpected enrollment gateway; refusing forwarding of device token.'
        }
        $qtPath = 'C:\QtReal\6.7.3\msvc2019_64'
        $configure = @('-S', '.', '-B', 'build/p720', '-G', 'Visual Studio 17 2022', '-A', 'x64', '-DKMJ_BUILD_TESTS=ON', '-DQT_FEATURE_rhi_d3d12=ON')
        if (Test-Path -LiteralPath $qtPath) { $configure += ('-DCMAKE_PREFIX_PATH=' + $qtPath) }
        elseif ($env:CMAKE_PREFIX_PATH) { $configure += ('-DCMAKE_PREFIX_PATH=' + $env:CMAKE_PREFIX_PATH) }
        $agentConfig = @{
            gateway = 'https://kmjtechno.com/'
            token = [string]$grant.agent.token
            id = $deviceId
            tenant = [string]$grant.agent.tenant
            stateDir = $state
            projects = @(@{
                id = $projectId
                root = $cinecore
                writable = $true
                gates = @{
                    cinecore_configure = @{ command = 'cmake'; args = $configure; timeoutMs = 240000 }
                    cinecore_build = @{ command = 'cmake'; args = @('--build', 'build/p720', '--config', 'Release', '--parallel', '12'); timeoutMs = 1800000 }
                    cinecore_ctest = @{ command = 'ctest'; args = @('--test-dir', 'build/p720', '-C', 'Release', '--output-on-failure'); timeoutMs = 1200000 }
                }
            })
            license = @{ mode = 'free' }
        }
        if (Test-Path -LiteralPath $config) { throw 'Private config created concurrently; refusing overwrite.' }
        [IO.File]::WriteAllText($config, ($agentConfig | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
        Protect-File $config
        Status 'PASS' 'Independent scoped CineCore credential stored with private ACL.'
    } else {
        Protect-File $config
        $prior = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
        if ([string]$prior.id -cne $deviceId -or
            [string]$prior.gateway -ne 'https://kmjtechno.com/' -or
            [string]$prior.tenant -eq '' -or [string]$prior.token -eq '' -or
            [string]$prior.stateDir -ne $state -or
            [string]$prior.license.mode -ne 'free' -or
            @($prior.projects).Count -ne 1 -or
            [string]$prior.projects[0].id -cne $projectId -or
            [string]$prior.projects[0].root -ne $cinecore) {
            throw 'Existing CineCore config does not match the approved project boundary.'
        }
        Status 'PASS' 'Previously approved CineCore credential reused, no re-pairing.'
    }
    $processes = @(Find-CineCoreAgent)
    if ($processes.Count -gt 1) { throw 'Multiple matching CineCore agents: refusing duplicate startup.' }
    if ($processes.Count -eq 1) {
        Status 'INFO' ('Scoped CineCore agent already running, PID ' + $processes[0].ProcessId)
    } else {
        $connection = Join-Path $state 'connection.json'
        $started = [DateTime]::UtcNow
        $p = Start-Process -FilePath $node -ArgumentList @('src/cli.js', 'agent', $config) -WorkingDirectory $codebridge -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'p720-cinecore-agent-out.log') -RedirectStandardError (Join-Path $logs 'p720-cinecore-agent-err.log') -PassThru
        Status 'INFO' ('Scoped CineCore agent started, PID ' + $p.Id)
        $online = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Seconds 2
            $p.Refresh()
            if ($p.HasExited) { throw 'CineCore agent process exited; inspect its local logs.' }
            if (Test-Path -LiteralPath $connection) {
                try {
                    $stamp = [DateTime]::Parse((Get-Content -LiteralPath $connection -Raw | ConvertFrom-Json).connectedAt).ToUniversalTime()
                    if ($stamp -ge $started.AddSeconds(-2)) { $online = $true; break }
                } catch { }
            }
        }
        if ($online) { Status 'PASS' 'Authenticated CineCore agent heartbeat verified.' }
        else { Status 'WARN' 'Agent running, but new gateway heartbeat not verified.' }
    }
    if (!(Get-Command cmake.exe -ErrorAction SilentlyContinue)) { Status 'WARN' 'CMake missing: CineCore configure/build gates will be blocked.' }
    if (!(Test-Path -LiteralPath 'C:\QtReal\6.7.3\msvc2019_64') -and !$env:CMAKE_PREFIX_PATH) {
        Status 'WARN' 'Qt6 MSVC kit not detected: Release build may be blocked until installed.'
    }
    Configure-ClaudeMcp
    Status 'NEXT' ('CodeBridge device = ' + $deviceId + '; project = ' + $projectId)
    Status 'NEXT' 'Run CodeBridge connection_overview; then CineCore configure/build/ctest gates.'
    Status 'NEXT' 'In Claude Code use /mcp and authorize kmj-codebridge over HTTPS.'
    Status 'NEXT' 'Upload only P720-CINECORE-AUTH-RESULT.txt; NEVER private enrollment or agent config.'
} catch {
    if (Test-Path -LiteralPath $report) {
        Status 'BLOCKED' ([string]$_.Exception.Message)
    } else { Write-Host ('BLOCKED: ' + $_.Exception.Message) }
    exit 2
}
