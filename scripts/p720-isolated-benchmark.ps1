# KMJ CodeBridge P720 — immutable source, zero-service-change local benchmark.
# Requires an existing trusted P720 repository and Node >=24.
# Never restarts agents, edits private enrollment, resets main or installs models.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = 'D:\KMJ-HyperSpeed\projects\kmj-codebridge'
$pinned = '4730f2c619d5e39777cad62a83444e39837412c1'
$benchRoot = 'D:\KMJ-HyperSpeed\bench'
$worktree = Join-Path $benchRoot 'codebridge-pr304-4730f2c'
$allowedOrigins = @(
    'https://github.com/kmjtechno/kmj-codebridge',
    'https://github.com/kmjtechno/kmj-codebridge.git',
    'git@github.com:kmjtechno/kmj-codebridge.git'
)
$created = $false
$initialHead = $null
$initialStatus = $null
$exitCode = 2

function Invoke-TrustedGit([string[]]$GitArguments) {
    # PowerShell 5.1 may promote successful Git stderr progress into a
    # terminating error under Stop (especially fetch and worktree add).
    # Keep exact numeric Git exit verification and never return stderr as
    # a revision string, path, SHA or benchmark provenance.
    $previousPreference = $ErrorActionPreference
    $output = $null
    $gitExitCode = -1
    try {
        $ErrorActionPreference = 'Continue'
        $output = & git.exe -C $repo @GitArguments 2>&1
        $gitExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($gitExitCode -ne 0) { throw 'GIT_PREFLIGHT_OR_COMMAND_FAILED' }
    return $output | Where-Object { $_ -is [string] }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_P720_REQUIRED' }
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
        throw 'CODEBRIDGE_CHECKOUT_NOT_FOUND'
    }
    $git = Get-Command git.exe -ErrorAction Stop
    $node = Get-Command node.exe -ErrorAction Stop
    $versionText = [string](& $node.Source --version)
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
        throw 'NODE24_REQUIRED'
    }
    $origin = [string]((Invoke-TrustedGit -GitArguments @('remote', 'get-url', 'origin')) | Select-Object -First 1)
    if ($allowedOrigins -cnotcontains $origin.Trim()) { throw 'UNTRUSTED_GITHUB_ORIGIN' }
    $initialHead = [string]((Invoke-TrustedGit -GitArguments @('rev-parse', 'HEAD')) | Select-Object -First 1)
    $initialStatus = @(& $git.Source -C $repo status --porcelain 2>$null) -join [char]10
    if ($LASTEXITCODE -ne 0) { throw 'GIT_STATUS_UNAVAILABLE' }
    if (Test-Path -LiteralPath $worktree) { throw 'BENCH_WORKTREE_ALREADY_EXISTS' }

    # Fetch objects and FETCH_HEAD only; never fast-forward the live checkout.
    Invoke-TrustedGit -GitArguments @('fetch', '--quiet', '--no-tags', 'origin', 'main') | Out-Null
    $remoteHead = [string]((Invoke-TrustedGit -GitArguments @('rev-parse', '--verify', 'FETCH_HEAD')) | Select-Object -First 1)
    & $git.Source -C $repo merge-base --is-ancestor $pinned $remoteHead 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'PINNED_SHA_NOT_IN_TRUSTED_MAIN' }

    New-Item -ItemType Directory -Path $benchRoot -Force | Out-Null
    Invoke-TrustedGit -GitArguments @('worktree', 'add', '--quiet', '--detach', $worktree, $pinned) | Out-Null
    $created = $true
    Write-Host ('SOURCE_EXACT_SHA=' + $pinned)
    Write-Host 'SOURCE_ISOLATED=YES'
    Write-Host 'AGENT_AND_ENROLLMENT_UNCHANGED=YES'

    $script = Join-Path $worktree 'scripts\p720-local-benchmark.mjs'
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        throw 'VERIFIED_BENCHMARK_SCRIPT_MISSING'
    }
    & $node.Source $script --run
    $exitCode = $LASTEXITCODE
} catch {
    Write-Host ('BENCH_BLOCKED=' + [string]$_.Exception.Message)
    $exitCode = 2
} finally {
    if ($created) {
        # A dirty worktree must remain for inspection, not be force-removed.
        & git.exe -C $repo worktree remove $worktree 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'ISOLATED_WORKTREE_CLEANUP=BLOCKED_INSPECT_MANUALLY'
            $exitCode = 2
        } else {
            Write-Host 'ISOLATED_WORKTREE_CLEANUP=PASS'
        }
    }
    if ($initialHead) {
        $finalHead = @(& git.exe -C $repo rev-parse HEAD 2>$null) -join ''
        $finalStatus = @(& git.exe -C $repo status --porcelain 2>$null) -join [char]10
        if ($finalHead -cne $initialHead -or $finalStatus -cne $initialStatus) {
            Write-Host 'LIVE_WORKTREE_UNCHANGED=NOT_VERIFIED'
            $exitCode = 2
        } else {
            Write-Host 'LIVE_WORKTREE_UNCHANGED=PASS'
        }
    }
}
exit $exitCode
