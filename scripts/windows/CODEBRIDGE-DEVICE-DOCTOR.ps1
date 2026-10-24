# KMJ CodeBridge - read-only Windows device connection diagnostic.
# No credential reads, privilege changes, checkout mutations, or agent restarts.
[CmdletBinding()]
param(
    [ValidateSet('HomeOffice','P720')]
    [string]$Device = 'HomeOffice',
    [switch]$SelfTest
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$trustedOrigins = @(
    'https://github.com/kmjtechno/kmj-codebridge.git',
    'https://github.com/kmjtechno/kmj-codebridge',
    'git@github.com:kmjtechno/kmj-codebridge.git'
)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$expectedComputer = if ($Device -eq 'HomeOffice') { 'DESKTOP-5FVJMET' } else { 'DESKTOP-K3AHHEM' }
$configFile = if ($Device -eq 'HomeOffice') {
    Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\private\homeoffice-calibration-pro\agent.json'
} else {
    'D:\KMJ-HyperSpeed\private\p720-codebridge\agent.json'
}
$reconnect = if ($Device -eq 'HomeOffice') {
    Join-Path $PSScriptRoot 'CONNECT-CALIBRATION-PRO.cmd'
} else {
    Join-Path $PSScriptRoot 'CONNECT-P720-CODEBRIDGE.cmd'
}
$pair = if ($Device -eq 'HomeOffice') {
    Join-Path $PSScriptRoot 'PAIR-HOMEOFFICE-CALIBRATION.cmd'
} else { $null }

function OrdinaryFileStatus([string]$Value) {
    try {
        $item = Get-Item -LiteralPath $Value -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            return 'UNTRUSTED'
        }
        return 'PRESENT'
    } catch [System.Management.Automation.ItemNotFoundException] {
        return 'NOT_FOUND'
    } catch {
        return 'UNKNOWN'
    }
}

function CandidateCount([string]$ConfigPath) {
    # Command line is read into process memory only. Never emit its contents,
    # PID, identity or private paths; an observed process is NOT a gateway grant.
    try {
        $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
        $found = @($processes | Where-Object {
            $cmd = [string]$_.CommandLine
            $cmd.Length -gt 0 -and
            $cmd.IndexOf($ConfigPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $cmd -match 'src[\\/]cli\.js' -and
            $cmd -match '\bagent\b'
        })
        if ($found.Count -eq 0) { return 'NOT_OBSERVED' }
        if ($found.Count -eq 1) { return 'ONE_CANDIDATE' }
        return 'MULTIPLE_CANDIDATES'
    } catch {
        return 'UNKNOWN'
    }
}

function TrustedRuntimeStatus([string]$Location) {
    try {
        if (!(Test-Path -LiteralPath $Location -PathType Container)) { return 'NOT_FOUND' }
        $git = Get-Command git.exe -ErrorAction Stop
        $origin = [string]((& $git.Source -C $Location remote get-url origin 2>$null) | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or $origin.Trim() -cnotin $trustedOrigins) { return 'UNTRUSTED' }
        $head = [string]((& $git.Source -C $Location rev-parse --verify HEAD 2>$null) | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or $head.Trim() -cnotmatch '^[0-9a-f]{40}$') { return 'UNVERIFIED' }
        $changes = @(& $git.Source --no-optional-locks -C $Location status --porcelain=v1 --untracked-files=no)
        if ($LASTEXITCODE -ne 0) { return 'UNVERIFIED' }
        if ($changes.Count -gt 0) { return 'TRUSTED_DIRTY_PRESERVED' }
        return 'TRUSTED_CLEAN'
    } catch {
        return 'UNKNOWN'
    }
}

function SafeCommandStatus([string]$Name, [string]$Minimum) {
    try {
        $exe = Get-Command $Name -ErrorAction Stop
        if ($Name -eq 'node.exe') {
            $v = [string](& $exe.Source --version)
            if ($LASTEXITCODE -ne 0 -or $v -notmatch '^v([0-9]+)\.') { return 'UNVERIFIED' }
            if ([int]$Matches[1] -lt [int]$Minimum) { return 'OUTDATED' }
        }
        return 'AVAILABLE'
    } catch {
        return 'NOT_FOUND'
    }
}

if ($SelfTest) {
    if ((OrdinaryFileStatus 'Z:\no-such-codebridge-config-20261024.json') -eq 'PRESENT') {
        throw 'DOCTOR_SELFTEST_MISSING_FILE_ACCEPTED'
    }
    Write-Output 'KMJ_PC_DOCTOR_SELFTEST=PASS'
    Write-Output 'CREDENTIALS_READ=NO'
    Write-Output 'HOST_CHANGES=NONE'
    exit 0
}

$report = [ordered]@{
    PRODUCT = 'KMJ_CODEBRIDGE'
    MODE = 'READ_ONLY'
    DEVICE_SCOPE = $Device.ToUpperInvariant()
    DEVICE_HOST_MATCH = 'UNKNOWN'
    PRIVATE_CONFIG = 'UNKNOWN'
    NODE24 = 'UNKNOWN'
    GIT = 'UNKNOWN'
    POWERSHELL7 = 'UNKNOWN'
    TRUSTED_CODEBRIDGE_RUNTIME = 'UNKNOWN'
    RECONNECT_LAUNCHER = 'UNKNOWN'
    PAIR_LAUNCHER = 'NOT_APPLICABLE'
    LOCAL_AGENT_PROCESS = 'UNKNOWN'
    GATEWAY_AUTHENTICATED = 'NOT_VERIFIED'
    OWNER_CHECKOUT = 'UNTOUCHED'
    CREDENTIALS_READ = 'NO'
    NEXT_ACTION = 'REVIEW_LOCAL_DIAGNOSTIC'
}
try {
    if ($env:OS -cne 'Windows_NT') { throw 'WINDOWS_ONLY' }
    $report.DEVICE_HOST_MATCH = if ($env:COMPUTERNAME -ieq $expectedComputer) {
        'YES'
    } else { 'NO' }
    $report.PRIVATE_CONFIG = OrdinaryFileStatus $configFile
    $report.RECONNECT_LAUNCHER = OrdinaryFileStatus $reconnect
    if ($null -ne $pair) { $report.PAIR_LAUNCHER = OrdinaryFileStatus $pair }
    $report.NODE24 = SafeCommandStatus 'node.exe' '24'
    $report.GIT = SafeCommandStatus 'git.exe' '0'
    $pwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    $report.POWERSHELL7 = OrdinaryFileStatus $pwsh
    $report.TRUSTED_CODEBRIDGE_RUNTIME = TrustedRuntimeStatus $root
    $report.LOCAL_AGENT_PROCESS = CandidateCount $configFile

    if ($report.DEVICE_HOST_MATCH -ne 'YES') {
        $report.NEXT_ACTION = 'CHECK_DEVICE_HOST_IDENTITY'
    } elseif ($report.PRIVATE_CONFIG -eq 'UNTRUSTED') {
        $report.NEXT_ACTION = 'REVIEW_PRIVATE_CONFIG_PATH_SECURITY'
    } elseif ($report.LOCAL_AGENT_PROCESS -eq 'MULTIPLE_CANDIDATES') {
        $report.NEXT_ACTION = 'BLOCK_DUPLICATE_AGENT_REVIEW'
    } elseif ($report.LOCAL_AGENT_PROCESS -eq 'UNKNOWN') {
        $report.NEXT_ACTION = 'CHECK_WINDOWS_PROCESS_VISIBILITY'
    } elseif ($report.LOCAL_AGENT_PROCESS -eq 'ONE_CANDIDATE') {
        $report.NEXT_ACTION = 'VERIFY_SERVER_SIDE_DEVICE_GRANT'
    } elseif ($report.PRIVATE_CONFIG -eq 'PRESENT') {
        $report.NEXT_ACTION = 'USE_APPROVED_RECONNECT_LAUNCHER'
    } elseif ($Device -eq 'HomeOffice' -and $report.PRIVATE_CONFIG -eq 'NOT_FOUND') {
        $report.NEXT_ACTION = 'USE_OWNER_APPROVED_PAIRING_LAUNCHER'
    } else {
        $report.NEXT_ACTION = 'REVIEW_EXISTING_ENROLLMENT_NO_TOKEN_COPY'
    }
} catch {
    # No exception text: even OS errors may reveal private user paths.
    $report.NEXT_ACTION = 'LOCAL_DIAGNOSTIC_INCOMPLETE'
}
foreach ($entry in $report.GetEnumerator()) {
    Write-Output ('{0}={1}' -f $entry.Key, [string]$entry.Value)
}
