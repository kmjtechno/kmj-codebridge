# KMJ TECHNO | Owner-clicked, fail-closed Home Office CodeBridge runtime bootstrap.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$device = 'DESKTOP-5FVJMET'
$sha = '0a1fcd6804a70e915ecf66df0d4a7786f5270f02'
$origin = 'https://github.com/kmjtechno/kmj-codebridge.git'
$validOrigins = @($origin, 'https://github.com/kmjtechno/kmj-codebridge', 'git@github.com:kmjtechno/kmj-codebridge.git')
$dest = 'E:\KMJ\CodeBridge-HomeOffice'
# A previously occupied checkout is never renamed, modified, or removed.
# Place new trusted runtime in a predictable SHA-named sibling directory instead.
$isolatedDest = Join-Path 'E:\KMJ' ('CodeBridge-HomeOffice-' + $sha.Substring(0,12))
$candidates = @($dest, $isolatedDest, 'E:\KMJ\CodeBridge', 'E:\KMJ\kmj-codebridge', 'D:\KMJ-HyperSpeed')
function Mark([string]$K,[string]$V) { Write-Output ($K + '=' + $V) }
function OrdinaryDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if (!$item.PSIsContainer) { throw 'RUNTIME_NOT_DIRECTORY' }
    $cursor = $item
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RUNTIME_REPARSE_DENIED' }
        $cursor = $cursor.Parent
    }
}
function TrustedRuntime([string]$Root,[string]$Git) {
    if (!(Test-Path -LiteralPath $Root -PathType Container)) { return $false }
    OrdinaryDirectory $Root
    if (!(Test-Path -LiteralPath (Join-Path $Root 'src\cli.js') -PathType Leaf)) { return $false }
    $top = [string]((& $Git -C $Root rev-parse --show-toplevel 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($top)) { return $false }
    if ([IO.Path]::GetFullPath($top).TrimEnd([char]92) -ine [IO.Path]::GetFullPath($Root).TrimEnd([char]92)) { return $false }
    $url = [string]((& $Git -C $Root remote get-url origin 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $url.Trim() -cnotin $validOrigins) { return $false }
    $head = [string]((& $Git -C $Root rev-parse HEAD 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $head.Trim() -cne $sha) { return $false }
    $dirty = @(& $Git --no-optional-locks -C $Root status --porcelain=v1 --untracked-files=no)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Root 'node_modules\zod\package.json') -PathType Leaf)
}
try {
    if ($SelfTest) {
        if ($sha -cnotmatch '^[a-f0-9]{40}$' -or $origin -cnotmatch '^https://github.com/kmjtechno/') { throw 'SELFTEST_SHA_OR_ORIGIN' }
        Mark 'KMJ_IDE_BOOTSTRAP_SELFTEST' 'PASS'
        Mark 'HOST_CHANGES' 'NONE'
        exit 0
    }
    if ($env:OS -cne 'Windows_NT' -or $env:COMPUTERNAME -ine $device) { throw 'WRONG_WINDOWS_HOST' }
    $gitTool = Get-Command git.exe -ErrorAction SilentlyContinue
    if (!$gitTool) { throw 'GIT_REQUIRED' }
    $git = $gitTool.Source
    # Use an installed Node 24+ alongside npm. Portable LTS may not be on PATH.
    $nodeCandidates = New-Object 'System.Collections.Generic.List[string]'
    $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($pathNode) { $nodeCandidates.Add([string]$pathNode.Source) }
    $toolchains = Join-Path $env:LOCALAPPDATA 'KMJ-CaliPro\toolchains'
    if (Test-Path -LiteralPath $toolchains -PathType Container) {
        OrdinaryDirectory $toolchains
        $nodeCandidates.Add((Join-Path $toolchains 'node.exe'))
        foreach ($folder in @(Get-ChildItem -LiteralPath $toolchains -Directory -ErrorAction Stop |
            Where-Object { $_.Name -match '^node(?:[-._].+)?$' } |
            Select-Object -First 12)) {
            $nodeCandidates.Add((Join-Path $folder.FullName 'node.exe'))
            $nodeCandidates.Add((Join-Path $folder.FullName 'bin\node.exe'))
        }
    }
    $node = $null
    $npm = $null
    foreach ($candidate in @($nodeCandidates | Select-Object -Unique)) {
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $folder = Split-Path -Parent $candidate
        try {
            OrdinaryDirectory $folder
            $item = Get-Item -LiteralPath $candidate -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            $npmCandidate = Join-Path $folder 'npm.cmd'
            if (!(Test-Path -LiteralPath $npmCandidate -PathType Leaf)) { continue }
            $npmItem = Get-Item -LiteralPath $npmCandidate -ErrorAction Stop
            if (($npmItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            $version = [string](& $candidate --version 2>$null)
            if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v([0-9]+)\.' -or
                [int]$Matches[1] -lt 24) { continue }
            $node = $candidate
            $npm = $npmCandidate
            $env:PATH = $folder + [IO.Path]::PathSeparator + $env:PATH
            break
        } catch { continue }
    }
    if (!$node -or !$npm) { throw 'NODE24_NPM_REQUIRED' }
    Mark 'KMJ_IDE_NODE' 'EXISTING_LTS_VERIFIED'
    Mark 'NODE_GLOBAL_PATH_CHANGED' 'NO'
    OrdinaryDirectory 'E:\KMJ'
    $runtime = $null
    foreach ($candidate in $candidates) {
        try {
            if (TrustedRuntime $candidate $git) {
                $runtime = $candidate
                Mark 'KMJ_IDE_RUNTIME' 'EXISTING_TRUSTED_PINNED_CLEAN'
                break
            }
        } catch {
            if ($candidate -ieq $dest) { throw }
        }
    }
    if ($null -eq $runtime) {
        $installDest = $dest
        if (Test-Path -LiteralPath $dest) {
            # Existing primary path may be dirty, a different revision, or incomplete.
            # Preserve it exactly and refuse symlinks/reparse points.
            OrdinaryDirectory $dest
            Mark 'KMJ_IDE_PREVIOUS_RUNTIME' 'UNVERIFIED_PRESERVED_UNCHANGED'
            $installDest = $isolatedDest
            if (Test-Path -LiteralPath $isolatedDest) { throw 'ISOLATED_DESTINATION_OCCUPIED_NO_OVERWRITE' }
            Mark 'KMJ_IDE_NEW_RUNTIME' 'SHA_NAMED_ISOLATED_SIBLING'
        }
        if ($CheckOnly) {
            Mark 'KMJ_IDE_RUNTIME' 'INSTALL_REQUIRED'
            Mark 'HOST_CHANGES' 'NONE'
            exit 2
        }
        $stage = Join-Path 'E:\KMJ' ('CodeBridge-HomeOffice-stage-' + [guid]::NewGuid().ToString('N'))
        if (Test-Path -LiteralPath $stage) { throw 'STAGE_PATH_COLLISION' }
        Mark 'KMJ_IDE_INSTALL' 'FETCHING_PINNED_GITHUB_SOURCE'
        & $git clone --depth 1 --no-checkout --single-branch --branch main --no-tags $origin $stage 1>$null
        if ($LASTEXITCODE -ne 0) { throw 'GIT_CLONE_FAILED' }
        OrdinaryDirectory $stage
        & $git -C $stage fetch --depth 1 --no-tags origin $sha 1>$null
        if ($LASTEXITCODE -ne 0) { throw 'PINNED_FETCH_FAILED' }
        & $git -C $stage checkout --detach $sha 1>$null
        if ($LASTEXITCODE -ne 0) { throw 'PINNED_CHECKOUT_FAILED' }
        $head = [string]((& $git -C $stage rev-parse HEAD) | Select-Object -First 1)
        if ($head.Trim() -cne $sha) { throw 'COMMIT_HASH_MISMATCH' }
        Mark 'KMJ_IDE_INSTALL' 'INSTALLING_LOCKED_DEPENDENCIES_NO_SCRIPTS'
        Push-Location -LiteralPath $stage
        try {
            & $npm ci --ignore-scripts --no-audit --no-fund 1>$null
            if ($LASTEXITCODE -ne 0) { throw 'NPM_LOCKFILE_INSTALL_FAILED' }
        } finally { Pop-Location }
        if (!(TrustedRuntime $stage $git)) { throw 'STAGED_RUNTIME_UNTRUSTED' }
        if (Test-Path -LiteralPath $installDest) { throw 'DESTINATION_APPEARED_NO_OVERWRITE' }
        Move-Item -LiteralPath $stage -Destination $installDest -ErrorAction Stop
        if (!(TrustedRuntime $installDest $git)) { throw 'PROMOTION_VERIFY_FAILED' }
        $runtime = $installDest
        Mark 'KMJ_IDE_INSTALL' 'PINNED_RUNTIME_READY'
    }
    Mark 'KMJ_IDE_SOURCE_SHA' $sha
    if ($CheckOnly) { Mark 'KMJ_IDE_CONNECT' 'NOT_STARTED_CHECK_ONLY'; exit 0 }
    $launcher = Join-Path $runtime 'scripts\windows\ONE-CLICK-AGENT-AUTOCONNECT.ps1'
    if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'APPROVED_LAUNCHER_MISSING' }
    & powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File $launcher -Device HomeOffice
    if ($LASTEXITCODE -ne 0) { throw 'OWNER_PAIRING_OR_RECONNECT_NOT_VERIFIED' }
    Mark 'KMJ_IDE_CONNECT' 'LOCAL_SCRIPT_COMPLETED'
    Mark 'ACCOUNT_SIDE_READY' 'NOT_ATTESTED_CHECK_CODEBRIDGE'
} catch {
    $reason = [string]$_.Exception.Message
    if ($reason -cnotmatch '^[A-Z][A-Z0-9_]{2,100}$') { $reason = 'LOCAL_INSTALL_PRECONDITION_FAILED' }
    Mark 'KMJ_IDE_BOOTSTRAP' ('BLOCKED:' + $reason)
    Mark 'CALIBRATION_AND_EXISTING_AGENTS' 'UNTOUCHED'
    Mark 'OWNER_APPROVAL_BYPASSED' 'NO'
    exit 2
}
