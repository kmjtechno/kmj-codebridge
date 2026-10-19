# KMJ CodeBridge - first-party guarded P720 agent runtime update.
# Normal Git HTTPS/SSH is supported. No Desktop Commander or ChatGPT GitHub
# connector is involved, and no enrollment/credentials are sent to GitHub.
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$TargetSha,
    [switch]$AllowTrackedDirtyCheckout,
    [switch]$AllowUntrackedFiles
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = 'D:\KMJ-HyperSpeed\projects\kmj-codebridge'
$private = 'D:\KMJ-HyperSpeed\private\p720-codebridge'
$configPath = Join-Path $private 'agent.json'
$statePath = Join-Path $private 'state'
$releases = 'D:\KMJ-HyperSpeed\codebridge-releases'
$release = Join-Path $releases $TargetSha
$logs = 'D:\KMJ-HyperSpeed\logs'
$expectedGateway = 'https://kmjtechno.com'
$allowedOrigins = @(
    'https://github.com/kmjtechno/kmj-codebridge',
    'https://github.com/kmjtechno/kmj-codebridge.git',
    'git@github.com:kmjtechno/kmj-codebridge.git'
)
$oldStopped = $false
$newPid = $null
$oldPid = $null
$initialHead = $null
$initialStatus = $null
$initialDigests = $null
$exitCode = 2

function AssertApprovedGateway([string]$value) {
    # The P720 pairing script persists the canonical origin WITH a trailing
    # slash. A slashless canonical URL is also valid. No other path, query,
    # endpoint or legacy external origin is allowed to receive the device token.
    if ($value -cnotin @($expectedGateway, ($expectedGateway + '/'))) {
        throw 'AGENT_GATEWAY_NOT_APPROVED'
    }
}

function Git([string[]]$GitArgs) {
    # Windows PowerShell 5 promotes native Git's successful stderr progress
    # ("From ...", "Preparing worktree ...") to terminating errors under Stop.
    # Only Git's numeric process exit code determines success. Never echo
    # stderr (remote URLs or local path details) back to the caller.
    $previousPreference = $ErrorActionPreference
    $result = $null
    $exitCode = -1
    try {
        $ErrorActionPreference = 'Continue'
        $result = & git.exe -C $repo @GitArgs 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { throw 'GIT_OPERATION_FAILED' }
    # Return only native stdout for rev-parse/remote queries.
    return $result | Where-Object { $_ -is [string] }
}

function FileSha256([string]$Path) {
    # Built-in .NET SHA256 avoids relying on auto-loaded PowerShell modules
    # during isolated/no-profile Windows agent verification.
    $hasher = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '')
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $hasher.Dispose()
    }
}

function SnapshotTrackedChanges {
    # Preserve unstaged tracked edits and explicitly opted-in untracked files.
    # Stage/rename/delete/conflicts/reparse paths fail closed.
    $rows = @(& git.exe -C $repo -c core.quotePath=false status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'LIVE_CHECKOUT_STATUS_FAILED' }
    if ($rows.Count -gt 64) { throw 'LIVE_CHECKOUT_DIRTY_LIMIT' }
    $digests = @()
    $trackedCount = 0
    $untrackedCount = 0
    $canonicalRoot = [IO.Path]::GetFullPath($repo).TrimEnd([char]92, [char]47)
    $rootWithSlash = $canonicalRoot + [IO.Path]::DirectorySeparatorChar
    foreach ($row in $rows) {
        if ($row.Length -lt 4) { throw 'LIVE_CHECKOUT_UNSUPPORTED_CHANGE' }
        if ($row.StartsWith(' M ')) {
            $trackedCount++
        } elseif ($row.StartsWith('?? ')) {
            $untrackedCount++
        } else {
            throw 'LIVE_CHECKOUT_UNSUPPORTED_CHANGE'
        }
        $relative = $row.Substring(3)
        # Accept only safe unquoted relative paths; refuse drive/ADS/path tricks.
        $segments = @($relative.Split('/'))
        if ($relative -cnotmatch '^[A-Za-z0-9_./-]+$' -or
            $segments -contains '..' -or $segments -contains '.' -or
            $segments -contains '') {
            throw 'LIVE_CHECKOUT_UNTRUSTED_PATH'
        }
        if ($relative.StartsWith('"') -or $relative.Contains(' -> ') -or
            $relative.Contains([char]13) -or $relative.Contains([char]10)) {
            throw 'LIVE_CHECKOUT_UNTRUSTED_PATH'
        }
        # Avoid provider/current-directory interpretation of nested Git paths.
        # Normalize both sides through .NET's canonical Win32 path semantics.
        $child = $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $fullPath = [IO.Path]::GetFullPath([IO.Path]::Combine($canonicalRoot, $child))
        # The allowlisted nonempty relative components above prevent absolute
        # paths and traversal. Forbid *intermediate* reparse-point directories
        # as well as the final file: no junction may redirect outside root.
        $folder = $canonicalRoot
        for ($index = 0; $index -lt ($segments.Count - 1); $index++) {
            $folder = [IO.Path]::Combine($folder, $segments[$index])
            $parent = Get-Item -LiteralPath $folder -Force -ErrorAction Stop
            if (!$parent.PSIsContainer -or
                ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'LIVE_CHECKOUT_UNTRUSTED_PATH'
            }
        }
        if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw 'LIVE_CHECKOUT_UNTRUSTED_PATH'
        }
        $item = Get-Item -LiteralPath $fullPath
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'LIVE_CHECKOUT_UNTRUSTED_PATH'
        }
        if ($row.StartsWith('?? ') -and $item.Length -gt 8388608) {
            throw 'LIVE_CHECKOUT_UNTRACKED_FILE_TOO_LARGE'
        }
        $digest = FileSha256 -Path $fullPath
        $digests += ($relative + ':' + $digest)
    }
    return @{
        Status = ($rows -join [char]10)
        Digests = ($digests -join [char]10)
        ModifiedCount = $trackedCount
        UntrackedCount = $untrackedCount
    }
}
function AssertCheckoutUnchanged {
    $headNow = [string]((Git -GitArgs @('rev-parse', 'HEAD')) |
        Select-Object -First 1)
    if ($headNow -cne $initialHead) {
        throw 'LIVE_CHECKOUT_HEAD_CHANGED'
    }
    $current = SnapshotTrackedChanges
    if ($current.Status -cne $initialStatus -or
        $current.Digests -cne $initialDigests) {
        throw 'LIVE_CHECKOUT_BYTES_CHANGED'
    }
}

function ResolvePreviousAgentSource([string]$commandLine) {
    # Existing agent may already run from a previously staged, immutable release.
    # Never roll it back to the modified shared checkout by assumption.
    $original = @{
        Entry = (Join-Path $repo 'src\cli.js')
        WorkDir = $repo
        PreviousSha = $null
    }
    if ($commandLine -notmatch 'codebridge-releases[\\/]') {
        return $original
    }

    # Accept exactly one Git-managed release below this hardcoded releases root.
    # Reject arbitrary executable paths, symlinks, unexpected commit labels,
    # additional release-path references and non-Git directories.
    $rootPattern = [regex]::Escape($releases.TrimEnd([char]92, [char]47))
    $pattern = $rootPattern + '[\\/](?<sha>[a-f0-9]{40})[\\/]src[\\/]cli\.js'
    $releaseHits = [regex]::Matches($commandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($releaseHits.Count -ne 1) {
        throw 'EXISTING_AGENT_RELEASE_PATH_REQUIRES_MANUAL_REVIEW'
    }
    $unmatched = [regex]::Replace($commandLine, $pattern, '', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($unmatched -match 'codebridge-releases[\\/]') {
        throw 'EXISTING_AGENT_RELEASE_PATH_REQUIRES_MANUAL_REVIEW'
    }
    $priorSha = $releaseHits[0].Groups['sha'].Value.ToLowerInvariant()
    if ($priorSha -ceq $TargetSha) {
        throw 'EXISTING_AGENT_ALREADY_ON_TARGET'
    }
    $oldDir = Join-Path $releases $priorSha
    $oldEntry = Join-Path $oldDir 'src\cli.js'
    foreach ($folder in @($releases, $oldDir, (Join-Path $oldDir 'src'))) {
        if (!(Test-Path -LiteralPath $folder -PathType Container) -or
            ((Get-Item -LiteralPath $folder).Attributes -band
                [IO.FileAttributes]::ReparsePoint)) {
            throw 'EXISTING_AGENT_RELEASE_DIRECTORY_UNSAFE'
        }
    }
    if (!(Test-Path -LiteralPath $oldEntry -PathType Leaf) -or
        ((Get-Item -LiteralPath $oldEntry).Attributes -band
            [IO.FileAttributes]::ReparsePoint)) {
        throw 'EXISTING_AGENT_RELEASE_ENTRY_UNSAFE'
    }
    $actualHead = [string](& git.exe -C $oldDir rev-parse --verify HEAD)
    if ($LASTEXITCODE -ne 0 -or $actualHead.Trim() -cne $priorSha) {
        throw 'EXISTING_AGENT_RELEASE_SHA_MISMATCH'
    }
    $top = [string](& git.exe -C $oldDir rev-parse --show-toplevel)
    if ($LASTEXITCODE -ne 0 -or
        [IO.Path]::GetFullPath($top.Trim()) -ine
            [IO.Path]::GetFullPath($oldDir)) {
        throw 'EXISTING_AGENT_RELEASE_WORKTREE_MISMATCH'
    }
    $common = [string](& git.exe -C $oldDir rev-parse --git-common-dir)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($common)) {
        throw 'EXISTING_AGENT_RELEASE_GIT_UNTRUSTED'
    }
    $actualCommon = [IO.Path]::GetFullPath([IO.Path]::Combine($oldDir, $common.Trim()))
    $expectedCommon = [IO.Path]::GetFullPath((Join-Path $repo '.git'))
    if ($actualCommon -ine $expectedCommon) {
        # Historical managed releases may be independently cloned rather
        # than linked worktrees. Preserve rollback only for a verified Git
        # clone housed entirely inside this immutable SHA release directory.
        $standaloneGit = Join-Path $oldDir '.git'
        if (!(Test-Path -LiteralPath $standaloneGit -PathType Container)) {
            throw 'EXISTING_AGENT_RELEASE_GIT_UNTRUSTED'
        }
        $gitItem = Get-Item -LiteralPath $standaloneGit -Force
        if (!$gitItem.PSIsContainer -or
            ($gitItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'EXISTING_AGENT_RELEASE_GIT_UNTRUSTED'
        }
        $expectedStandalone = [IO.Path]::GetFullPath($standaloneGit)
        if ($actualCommon -ine $expectedStandalone) {
            throw 'EXISTING_AGENT_RELEASE_GIT_UNTRUSTED'
        }
        $gitDir = [string](& git.exe -C $oldDir rev-parse --absolute-git-dir)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitDir) -or
            [IO.Path]::GetFullPath($gitDir.Trim()) -ine $expectedStandalone) {
            throw 'EXISTING_AGENT_RELEASE_GIT_UNTRUSTED'
        }
        $releaseOrigin = [string](& git.exe -C $oldDir remote get-url origin)
        if ($LASTEXITCODE -ne 0 -or
            $allowedOrigins -cnotcontains $releaseOrigin.Trim()) {
            throw 'EXISTING_AGENT_RELEASE_ORIGIN_UNTRUSTED'
        }
        # Reject local edits before trusting the exact rollback entry point.
        $trackedStatus = @(& git.exe -C $oldDir -c core.quotePath=false status --porcelain=v1 --untracked-files=no)
        if ($LASTEXITCODE -ne 0 -or $trackedStatus.Count -ne 0) {
            throw 'EXISTING_AGENT_RELEASE_TRACKED_DIRTY'
        }
        $expectedCliBlob = [string](& git.exe -C $oldDir rev-parse 'HEAD:src/cli.js')
        if ($LASTEXITCODE -ne 0 -or
            $expectedCliBlob.Trim() -notmatch '^[a-f0-9]{40}$') {
            throw 'EXISTING_AGENT_RELEASE_CLI_UNTRUSTED'
        }
        $actualCliBlob = [string](& git.exe -C $oldDir hash-object -- 'src/cli.js')
        if ($LASTEXITCODE -ne 0 -or
            $actualCliBlob.Trim() -cne $expectedCliBlob.Trim()) {
            throw 'EXISTING_AGENT_RELEASE_CLI_UNTRUSTED'
        }
    }
    return @{
        Entry = $oldEntry
        WorkDir = $oldDir
        PreviousSha = $priorSha
    }
}

function ScopedAgents {
    $items = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.Contains($configPath) -and
            $_.CommandLine -match 'src[\\/]cli\.js' -and
            $_.CommandLine -match '\bagent\b'
        })
    if ($items.Count -gt 1) { throw 'MULTIPLE_SCOPED_AGENTS' }
    return $items
}
function AssertIdle {
    foreach ($area in @('jobs', 'autopilot')) {
        $folder = Join-Path $statePath $area
        if (!(Test-Path -LiteralPath $folder)) { throw 'JOURNAL_UNAVAILABLE' }
        $files = @(Get-ChildItem -LiteralPath $folder -Recurse -File -Filter '*.json')
        if ($files.Count -gt 10000) { throw 'JOURNAL_LIMIT_EXCEEDED' }
        foreach ($file in $files) {
            $maxBytes = 131072
            if ($area -eq 'autopilot') { $maxBytes = 4194304 }
            if ($file.Length -gt $maxBytes -or
                ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'JOURNAL_UNTRUSTED'
            }
            try {
                $journal = Get-Content -LiteralPath $file.FullName -Raw |
                    ConvertFrom-Json
            } catch {
                throw 'JOURNAL_CORRUPT'
            }
            if ($area -eq 'jobs') {
                if ($journal.PSObject.Properties.Name -notcontains 'state') {
                    throw 'JOURNAL_STATE_MISSING'
                }
                if ([string]$journal.state -in @('running', 'queued')) {
                    throw 'ACTIVE_WORK_REQUIRES_DRAIN'
                }
            } else {
                if ($journal.PSObject.Properties.Name -notcontains 'tasks') {
                    throw 'AUTOPILOT_STATE_MISSING'
                }
                foreach ($task in @($journal.tasks)) {
                    if ([string]$task.state -eq 'running') {
                        throw 'ACTIVE_AUTOPILOT_LEASE'
                    }
                }
            }
        }
    }
}
function StartScoped([string]$entry, [string]$workDir, [string]$label) {
    $outFile = Join-Path $logs ($label + '-agent-out.log')
    $errFile = Join-Path $logs ($label + '-agent-err.log')
    $p = Start-Process -FilePath $node -ArgumentList @($entry, 'agent', $configPath) `
        -WorkingDirectory $workDir -WindowStyle Hidden `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru
    return $p.Id
}
function ConfirmRuntime([int]$processId, [string]$entry, [datetime]$since) {
    for ($try = 0; $try -lt 35; $try++) {
        Start-Sleep -Seconds 2
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
        if ($null -eq $proc -or !$proc.CommandLine.Contains($entry)) {
            return $false
        }
        $scoped = @(ScopedAgents)
        if ($scoped.Count -ne 1 -or [int]$scoped[0].ProcessId -ne $processId) {
            return $false
        }
        $recordFile = Join-Path $statePath 'connection.json'
        if (Test-Path -LiteralPath $recordFile) {
            try {
                $data = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
                $stamp = [datetime]::Parse([string]$data.connectedAt).ToUniversalTime()
                if ($stamp -ge $since.AddSeconds(-1)) { return $true }
            } catch {
                # A valid fresh authenticated heartbeat is required.
            }
        }
    }
    return $false
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_P720_REQUIRED' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $major = [string](& $node --version)
    if ($LASTEXITCODE -ne 0 -or $major -notmatch '^v(\d+)\.' -or
        [int]$Matches[1] -lt 24) { throw 'NODE24_REQUIRED' }
    $null = Get-Command git.exe -ErrorAction Stop
    $null = Get-Command npm.cmd -ErrorAction Stop
    foreach ($folder in @($repo, $private, $statePath)) {
        if (!(Test-Path -LiteralPath $folder -PathType Container) -or
            ((Get-Item -LiteralPath $folder).Attributes -band
                [IO.FileAttributes]::ReparsePoint)) {
            throw 'UNTRUSTED_PROJECT_OR_PRIVATE_PATH'
        }
    }
    if (!(Test-Path -LiteralPath $configPath -PathType Leaf) -or
        ((Get-Item -LiteralPath $configPath).Attributes -band
            [IO.FileAttributes]::ReparsePoint)) {
        throw 'PRIVATE_AGENT_CONFIG_MISSING'
    }
    $configDigest = (FileSha256 -Path $configPath)
    $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    AssertApprovedGateway ([string]$cfg.gateway)
    if (@($cfg.projects).Count -ne 1 -or
        [string]$cfg.projects[0].id -ne 'kmj-codebridge' -or
        [string]$cfg.projects[0].root -ne $repo -or
        [string]$cfg.stateDir -ne $statePath -or
        [string]$cfg.token -eq '') {
        throw 'AGENT_SCOPE_NOT_APPROVED'
    }
    $origin = [string]((Git -GitArgs @('remote', 'get-url', 'origin')) |
        Select-Object -First 1)
    if ($allowedOrigins -cnotcontains $origin.Trim()) {
        throw 'UNTRUSTED_SOURCE_REMOTE'
    }
    $branch = [string]((Git -GitArgs @('branch', '--show-current')) |
        Select-Object -First 1)
    if ($branch.Trim() -ne 'main') { throw 'ONLY_MAIN_CHECKOUT_SUPPORTED' }
    $initialHead = [string]((Git -GitArgs @('rev-parse', 'HEAD')) |
        Select-Object -First 1)
    $snapshot = SnapshotTrackedChanges
    $initialStatus = $snapshot.Status
    $initialDigests = $snapshot.Digests
    if ($snapshot.ModifiedCount -gt 0 -and !$AllowTrackedDirtyCheckout) {
        throw 'LIVE_CHECKOUT_NOT_CLEAN'
    }
    if ($snapshot.UntrackedCount -gt 0 -and !$AllowUntrackedFiles) {
        throw 'LIVE_CHECKOUT_UNTRACKED_APPROVAL_REQUIRED'
    }
    Write-Host ('TRACKED_DIRTY_FILES_PRESERVED=' + $snapshot.ModifiedCount)
    Write-Host ('UNTRACKED_FILES_FINGERPRINTED=' + $snapshot.UntrackedCount)
    if (Test-Path -LiteralPath $release) { throw 'RELEASE_ALREADY_EXISTS' }
    $agents = @(ScopedAgents)
    if ($agents.Count -ne 1) { throw 'ONE_EXISTING_AGENT_REQUIRED' }
    $oldPid = [int]$agents[0].ProcessId
    $oldCommand = [string]$agents[0].CommandLine
    $previous = ResolvePreviousAgentSource $oldCommand
    $oldEntry = [string]$previous.Entry
    $oldWorkDir = [string]$previous.WorkDir
    if ([string]$agents[0].ExecutablePath -ine $node) {
        throw 'EXISTING_NODE_RUNTIME_MISMATCH'
    }
    AssertIdle
    Write-Host 'PREFLIGHT=PASS'
    Write-Host ('TARGET_SHA=' + $TargetSha)
    Write-Host ('OLD_AGENT_PID=' + $oldPid)

    # Fetch Git commits directly; not via ChatGPT GitHub or desktop plugins.
    # Keep the running project's main checkout unchanged.
    Git -GitArgs @('fetch', '--quiet', '--no-tags', 'origin', 'main') | Out-Null
    $remote = [string]((Git -GitArgs @('rev-parse', '--verify', 'FETCH_HEAD')) |
        Select-Object -First 1)
    & git.exe -C $repo merge-base --is-ancestor $TargetSha $remote
    if ($LASTEXITCODE -ne 0) { throw 'SHA_NOT_ON_ORIGIN_MAIN' }
    & git.exe -C $repo merge-base --is-ancestor $initialHead $TargetSha
    if ($LASTEXITCODE -ne 0) { throw 'TARGET_NOT_FAST_FORWARD' }
    if ($null -ne $previous.PreviousSha) {
        & git.exe -C $repo merge-base --is-ancestor $previous.PreviousSha $TargetSha
        if ($LASTEXITCODE -ne 0) { throw 'PREVIOUS_RELEASE_NOT_ANCESTOR' }
    }

    New-Item -ItemType Directory -Path $releases, $logs -Force | Out-Null
    Git -GitArgs @('worktree', 'add', '--detach', $release, $TargetSha) | Out-Null
    $newEntry = Join-Path $release 'src\cli.js'
    if (!(Test-Path -LiteralPath $newEntry -PathType Leaf)) {
        throw 'RELEASE_ENTRY_MISSING'
    }
    & npm.cmd --prefix $release ci --include=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'RELEASE_DEPENDENCIES_FAILED' }
    & npm.cmd --prefix $release run check
    if ($LASTEXITCODE -ne 0) { throw 'RELEASE_CHECK_FAILED' }
    & npm.cmd --prefix $release test
    if ($LASTEXITCODE -ne 0) { throw 'RELEASE_TEST_FAILED' }
    & npm.cmd --prefix $release run scan:secrets
    if ($LASTEXITCODE -ne 0) { throw 'RELEASE_SECRET_SCAN_FAILED' }
    AssertCheckoutUnchanged
    AssertIdle
    $stillRunning = @(ScopedAgents)
    if ($stillRunning.Count -ne 1 -or
        [int]$stillRunning[0].ProcessId -ne $oldPid) {
        throw 'SCOPED_AGENT_CHANGED_DURING_STAGING'
    }
    if ((FileSha256 -Path $configPath) -cne
        $configDigest) { throw 'PRIVATE_CONFIG_CHANGED_DURING_STAGING' }
    Write-Host 'STAGED_TESTS=PASS'

    # Graceful attempt on the ONE known idle P720 CodeBridge agent only.
    Stop-Process -Id $oldPid -ErrorAction Stop
    $oldStopped = $true
    for ($wait = 0; $wait -lt 20; $wait++) {
        if (!(Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
        throw 'OLD_AGENT_NOT_STOPPED'
    }
    $startTime = [datetime]::UtcNow
    $newPid = StartScoped $newEntry $release ('runtime-' + $TargetSha.Substring(0, 12))
    if (!(ConfirmRuntime $newPid $newEntry $startTime)) {
        throw 'NEW_AGENT_HEARTBEAT_NOT_VERIFIED'
    }
    if ((FileSha256 -Path $configPath) -cne
        $configDigest) { throw 'PRIVATE_CONFIG_CHANGED' }
    Write-Host ('NEW_AGENT_PID=' + $newPid)
    Write-Host 'ENROLLMENT_CONFIG_UNCHANGED=PASS'
    Write-Host 'NEW_RUNTIME_HEARTBEAT=PASS'
    Write-Host 'ROLLBACK_SOURCE=PREVIOUS_VERIFIED_AGENT_RUNTIME'
    $exitCode = 0
} catch {
    Write-Host ('UPDATE_BLOCKED=' + [string]$_.Exception.Message)
} finally {
    if ($exitCode -ne 0 -and $oldStopped) {
        try {
            if ($null -ne $newPid -and
                (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) {
                Stop-Process -Id $newPid -ErrorAction Stop
                Start-Sleep -Seconds 2
            }
            if (@(ScopedAgents).Count -ne 0) {
                throw 'ROLLBACK_CONFLICT_OTHER_SCOPED_AGENT'
            }
            $rollbackTime = [datetime]::UtcNow
            # Return to the EXACT agent source that was running before update,
            # whether it was the shared checkout or an earlier managed release.
            $rollbackPid = StartScoped $oldEntry $oldWorkDir 'rollback-previous'
            if (!(ConfirmRuntime $rollbackPid $oldEntry $rollbackTime)) {
                throw 'ROLLBACK_HEARTBEAT_FAILED'
            }
            Write-Host 'ROLLBACK=PASS'
        } catch {
            Write-Host ('ROLLBACK=FAIL_MANUAL_RECOVERY_NEEDED:' +
                [string]$_.Exception.Message)
        }
    }
    if ($initialHead) {
        try {
            AssertCheckoutUnchanged
            Write-Host 'ORIGINAL_CHECKOUT_UNCHANGED=PASS'
        } catch {
            Write-Host 'ORIGINAL_CHECKOUT_UNCHANGED=FAIL'
            $exitCode = 2
        }
    }
}
exit $exitCode
