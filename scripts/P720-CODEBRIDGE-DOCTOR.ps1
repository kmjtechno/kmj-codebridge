# Read-only KMJ CodeBridge P720 connection and installed icon doctor.
# Does not open credentials, authorize, enroll, restart services, install
# software, edit files, modify Git, or contact any remote endpoint.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = 'D:\KMJ-HyperSpeed\projects\kmj-codebridge'
$trustedOrigins = @(
    'https://github.com/kmjtechno/kmj-codebridge',
    'https://github.com/kmjtechno/kmj-codebridge.git',
    'git@github.com:kmjtechno/kmj-codebridge.git'
)
$report = [ordered]@{
    product = 'KMJ CodeBridge'
    mode = 'READ_ONLY'
    sourcePath = 'D:\KMJ-HyperSpeed\projects\kmj-codebridge'
    checkout = 'NOT_FOUND'
    trustedOrigin = $false
    sourceBranch = 'UNKNOWN'
    sourceHead = 'UNKNOWN'
    trackedChanges = 'UNKNOWN'
    node24Available = $false
    appIconSource = 'NOT_CHECKED'
    claudeIconSource = 'NOT_CHECKED'
    installedLocalIcon = 'NOT_FOUND'
    localIconMatchesSource = 'NOT_VERIFIED'
    agentServiceStatus = 'NOT_FOUND'
    agentGatewayRegistration = 'NOT_VERIFIED_LOCALLY'
    liveChatGPTIcon = 'NOT_VERIFIED_EXTERNALLY'
    nextAction = 'CHECK_CODEBRIDGE_CONNECTION_OVERVIEW'
}
function Emit {
    foreach ($entry in $report.GetEnumerator()) {
        $v = [string]$entry.Value
        $v = $v -replace '[\r\n\t]', '_'
        Write-Output ('{0}={1}' -f $entry.Key, $v)
    }
}
try {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        $version = & $node.Source --version
        if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.') {
            $report.node24Available = ([int]$Matches[1] -ge 24)
        }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git') -PathType Container)) {
        $report.nextAction = 'INSTALL_OR_LOCATE_TRUSTED_CODEBRIDGE_CHECKOUT'
        Emit
        exit 2
    }
    $report.checkout = 'PRESENT'
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) {
        $report.nextAction = 'GIT_UNAVAILABLE'
        Emit
        exit 2
    }
    $origin = (& $git.Source -C $repo remote get-url origin 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $trustedOrigins -cnotcontains $origin) {
        $report.nextAction = 'UNTRUSTED_ORIGIN_NO_AUTOMATIC_CHANGES'
        Emit
        exit 3
    }
    $report.trustedOrigin = $true
    $report.sourceBranch = (& $git.Source -C $repo branch --show-current | Out-String).Trim()
    $head = (& $git.Source -C $repo rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $head -match '^[0-9a-f]{40}$') {
        $report.sourceHead = $head
    }
    $dirty = @(& $git.Source -C $repo status --porcelain --untracked-files=no)
    $report.trackedChanges = if ($dirty.Count -eq 0) { 'CLEAN' } else { 'DIRTY_PRESERVED' }

    $icon = Join-Path $repo 'plugin\assets\icon.png'
    $claude = Join-Path $repo 'claude-plugin\assets\icon.png'
    if (Test-Path -LiteralPath $icon -PathType Leaf) {
        $mainHash = (Get-FileHash -LiteralPath $icon -Algorithm SHA256).Hash
        $report.appIconSource = 'SHA256_' + $mainHash
        if (Test-Path -LiteralPath $claude -PathType Leaf) {
            $claudeHash = (Get-FileHash -LiteralPath $claude -Algorithm SHA256).Hash
            $report.claudeIconSource = if ($claudeHash -eq $mainHash) { 'MATCH' } else { 'MISMATCH' }
        }
        $installed = Join-Path $HOME '.codex\plugins\kmj-codebridge\assets\icon.png'
        if (Test-Path -LiteralPath $installed -PathType Leaf) {
            $report.installedLocalIcon = 'PRESENT'
            $installedHash = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
            $report.localIconMatchesSource = if ($installedHash -eq $mainHash) { 'MATCH' } else { 'STALE_DIFFERENT_BYTES' }
        }
    }
    $services = @(Get-Service -Name '*codebridge*' -ErrorAction SilentlyContinue)
    if ($services.Count -gt 0) {
        $report.agentServiceStatus = ($services | ForEach-Object { $_.Name + ':' + $_.Status } | Select-Object -First 8) -join ','
    }
    if ($report.localIconMatchesSource -eq 'STALE_DIFFERENT_BYTES') {
        $report.nextAction = 'LOCAL_ICON_CACHE_MISMATCH_REVIEW_EXISTING_INSTALLER'
    } elseif ($report.agentServiceStatus -eq 'NOT_FOUND') {
        $report.nextAction = 'CHECK_AGENT_STARTUP_AND_MAIN_PLATFORM_ENROLLMENT'
    } else {
        $report.nextAction = 'CHECK_GATEWAY_TOKEN_INTROSPECTION_WITH_OFFICIAL_APPROVED_AGENT'
    }
    Emit
} catch {
    # Do not print exceptions: OS command messages may carry private paths.
    $report.nextAction = 'LOCAL_DIAGNOSTIC_ERROR_CHECK_TRUSTED_INSTALLATION'
    Emit
    exit 4
}
