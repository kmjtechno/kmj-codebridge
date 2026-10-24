# KMJ TECHNO | Owner-clicked, fail-closed Home Office CodeBridge runtime bootstrap.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$device = 'DESKTOP-5FVJMET'
$sha = '9dc0ae25648c33a62631fdd35068e6b60820637d'
$origin = 'https://github.com/kmjtechno/kmj-codebridge.git'
$validOrigins = @($origin, 'https://github.com/kmjtechno/kmj-codebridge', 'git@github.com:kmjtechno/kmj-codebridge.git')
$dest = 'E:\KMJ\CodeBridge-HomeOffice'
$candidates = @($dest, 'E:\KMJ\CodeBridge', 'E:\KMJ\kmj-codebridge', 'D:\KMJ-HyperSpeed')
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
    $nodeTool = Get-Command node.exe -ErrorAction SilentlyContinue
    $npmTool = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (!$gitTool) { throw 'GIT_REQUIRED' }
    if (!$nodeTool -or !$npmTool) { throw 'NODE24_NPM_REQUIRED' }
    $git = $gitTool.Source
    $node = $nodeTool.Source
    $npm = $npmTool.Source
    $version = [string](& $node --version)
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v([0-9]+)\.' -or [int]$Matches[1] -lt 24) { throw 'NODE24_REQUIRED' }
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
        if (Test-Path -LiteralPath $dest) { throw 'EXISTING_DESTINATION_NOT_OVERWRITTEN' }
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
        if (Test-Path -LiteralPath $dest) { throw 'DESTINATION_APPEARED_NO_OVERWRITE' }
        Move-Item -LiteralPath $stage -Destination $dest -ErrorAction Stop
        if (!(TrustedRuntime $dest $git)) { throw 'PROMOTION_VERIFY_FAILED' }
        $runtime = $dest
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
