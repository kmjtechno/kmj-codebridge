# Reconnect the already enrolled, independent KMJ CineCore Windows agent.
# No enrollment, secret export, package install, Git fetch/reset or service restart.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = 'D:\KMJ-HyperSpeed'
$repo = Join-Path $root 'projects\kmj-codebridge'
$project = Join-Path $root 'projects\kmj-cinecore'
$private = Join-Path $root 'private\p720-cinecore'
$configPath = Join-Path $private 'agent.json'
$connectionPath = Join-Path $private 'state\connection.json'
$logDir = Join-Path $root 'logs'
$report = Join-Path $root 'P720-CINECORE-RECONNECT-RESULT.txt'
function Report([string]$result, [string]$description) {
    $line = $result + '=' + $description
    Write-Host $line
    Add-Content -LiteralPath $report -Value $line -Encoding UTF8
}
function Verify-Origin([string]$path, [string]$projectName) {
    if (-not (Test-Path -LiteralPath (Join-Path $path '.git'))) {
        throw ('TRUSTED_CHECKOUT_MISSING_' + $projectName)
    }
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'PROJECT_ROOT_REPARSE_POINT'
    }
    $origin = (& git.exe -C $path remote get-url origin)
    if ($LASTEXITCODE -ne 0) { throw 'GIT_ORIGIN_UNAVAILABLE' }
    $approved = @(
        ('https://github.com/kmjtechno/' + $projectName),
        ('https://github.com/kmjtechno/' + $projectName + '.git'),
        ('git@github.com:kmjtechno/' + $projectName + '.git')
    )
    if ($origin.Trim() -cnotin $approved) { throw 'UNTRUSTED_GIT_ORIGIN' }
}
function Fresh-Connection([datetime]$since) {
    if (-not (Test-Path -LiteralPath $connectionPath)) { return $false }
    try {
        $evidence = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
        $at = [DateTime]::Parse([string]$evidence.connectedAt).ToUniversalTime()
        return ($at -ge $since.AddSeconds(-2))
    } catch { return $false }
}
try {
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
    if (-not (Test-Path -LiteralPath $root)) { throw 'P720_WORKSPACE_MISSING' }
    Set-Content -LiteralPath $report -Value 'KMJ CineCore existing-agent reconnect (no private credentials)' -Encoding UTF8
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'GIT_NOT_FOUND' }
    Verify-Origin $repo 'kmj-codebridge'
    Verify-Origin $project 'kmj-cinecore'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $version = (& $node --version).Trim()
    if ($version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
        throw 'NODE_24_REQUIRED'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules\zod\package.json'))) {
        throw 'CODEBRIDGE_DEPENDENCIES_MISSING_USE_APPROVED_SETUP'
    }
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw 'CINECORE_ENROLLMENT_MISSING_USE_APPROVED_SETUP'
    }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not [string]$config.token -or -not [string]$config.tenant -or
        [string]$config.id -notmatch '^kmj-p720-cinecore-[A-Za-z0-9_-]+$' -or
        [string]$config.gateway -cne 'https://kmjtechno.com/' -or
        [string]$config.stateDir -cne (Join-Path $private 'state') -or
        @($config.projects).Count -ne 1 -or
        [string]$config.projects[0].id -cne 'kmj-cinecore' -or
        [string]$config.projects[0].root -cne $project -or
        [string]$config.license.mode -cne 'free') {
        throw 'EXISTING_AGENT_SCOPE_INVALID'
    }
    $agents = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($configPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $_.CommandLine -match 'src[\\/]cli\.js' -and
            $_.CommandLine -match '\bagent\b'
        })
    if ($agents.Count -gt 1) { throw 'MULTIPLE_SCOPED_AGENTS_BLOCKED' }
    if ($agents.Count -eq 1) {
        Report 'AGENT_PROCESS' 'ALREADY_RUNNING'
        Report 'GATEWAY_HEARTBEAT' 'RECHECK_IN_CODEBRIDGE_CONNECTION_OVERVIEW'
        exit 0
    }
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $since = [DateTime]::UtcNow
    $process = Start-Process -FilePath $node -ArgumentList @(
        'src/cli.js', 'agent', $configPath
    ) -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (
        Join-Path $logDir 'p720-cinecore-agent-out.log'
    ) -RedirectStandardError (
        Join-Path $logDir 'p720-cinecore-agent-err.log'
    ) -PassThru
    Report 'AGENT_PROCESS' 'STARTED_SCOPED_EXISTING_ENROLLMENT'
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 2
        $process.Refresh()
        if ($process.HasExited) { throw 'AGENT_EXITED_CHECK_LOCAL_LOGS' }
        if (Fresh-Connection $since) {
            Report 'GATEWAY_HEARTBEAT' 'FRESH_AUTHENTICATED'
            Report 'DEVICE' 'kmj-p720-cinecore'
            exit 0
        }
    }
    Report 'GATEWAY_HEARTBEAT' 'NOT_VERIFIED_CHECK_CODEBRIDGE_CONNECTION_OVERVIEW'
    exit 3
} catch {
    if (Test-Path -LiteralPath $report) {
        Report 'BLOCKED' ([string]$_.Exception.Message)
    } else {
        Write-Host ('BLOCKED=' + $_.Exception.Message)
    }
    exit 2
}
