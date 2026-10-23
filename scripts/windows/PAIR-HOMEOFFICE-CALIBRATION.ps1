# KMJ CodeBridge — Home Office Calibration first pairing (not P720).
# Current user, browser-approved only. Never modify project files.
[CmdletBinding()]
param(
    [string]$ProjectRoot = 'E:\KMJ\Codex\KMJ CalibrationNew',
    [switch]$CheckOnly,
    [switch]$SelfTest
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$device = 'kmj-homeoffice-desktop-5fvjmet'
$project = 'kmj-calibration-pro'
$gateway = 'https://kmjtechno.com'
$origins = @('https://github.com/kmjtechno/kmj-calibration-pro.git','https://github.com/kmjtechno/kmj-calibration-pro','git@github.com:kmjtechno/kmj-calibration-pro.git')
$runtimeOrigins = @('https://github.com/kmjtechno/kmj-codebridge.git','https://github.com/kmjtechno/kmj-codebridge','git@github.com:kmjtechno/kmj-codebridge.git')
$private = Join-Path $env:LOCALAPPDATA 'KMJ-CodeBridge\private\homeoffice-calibration-pro'
$state = Join-Path $private 'state'
$enrollment = Join-Path $private 'enrollment.json'
$configFile = Join-Path $private 'agent.json'

function Assert-Ordinary([string]$Value,[bool]$Directory) {
    $item = Get-Item -LiteralPath $Value -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne $Directory) { throw 'PATH_TYPE_MISMATCH' }
    $cursor = $item
    if (!$Directory) { $cursor = $item.Directory }
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UNTRUSTED_REPARSE_PATH' }
        $cursor = $cursor.Parent
    }
}
function Trusted-Git([string]$Root,[string[]]$Allowed) {
    $origin = [string]((& git.exe -C $Root remote get-url origin 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $origin.Trim() -cnotin $Allowed) { throw 'UNTRUSTED_REPOSITORY_ORIGIN' }
}
function Private-Acl([string]$Value,[bool]$Directory) {
    Assert-Ordinary $Value $Directory
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $grant = if ($Directory) { '*' + $sid + ':(OI)(CI)F' } else { '*' + $sid + ':F' }
    & icacls.exe $Value '/inheritance:r' '/grant:r' $grant 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'PRIVATE_ACL_FAILED' }
}
function Check-Gateway {
    try {
        $null = Invoke-WebRequest -Uri ($gateway + '/agent/health') -Method Post -ContentType 'application/json' -Body '{}' -MaximumRedirection 0 -TimeoutSec 15 -UseBasicParsing
        throw 'ANONYMOUS_GATEWAY_ACCESS'
    } catch [System.Net.WebException] {
        if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw 'PUBLIC_AGENT_ROUTE_NOT_PROTECTED_OR_UNREACHABLE' }
    }
}
function Valid-Grant($Grant) {
    if ($null -eq $Grant -or [string]$Grant.agent.id -cne $device -or [string]$Grant.agent.tenant -notmatch '^[A-Za-z0-9_-]{1,64}$' -or [string]$Grant.agent.token -notmatch '^.{32,4096}$' -or [string]$Grant.gateway -cnotin @($gateway,($gateway + '/')) -or @($Grant.projects | Where-Object { [string]$_.id -ceq $project }).Count -ne 1) { return $false }
    foreach ($p in @('read','write','execute')) { if (@($Grant.permissions) -cnotcontains $p) { return $false } }
    return $true
}

try {
    if ($env:OS -cne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
    if ($SelfTest) {
        $fake = [pscustomobject]@{ gateway=$gateway; agent=[pscustomobject]@{ id=$device; tenant='tenant1'; token=('x' * 32) }; projects=@([pscustomobject]@{ id=$project }); permissions=@('read','write','execute') }
        if (!(Valid-Grant $fake)) { throw 'SELFTEST_VALID_GRANT_REJECTED' }
        $fake.agent.id = 'kmj-p720-calibration-desktop-k3ahhem'
        if (Valid-Grant $fake) { throw 'SELFTEST_P720_GRANT_ACCEPTED' }
        $fake.agent.id = $device
        $fake.gateway = 'https://example.invalid'
        if (Valid-Grant $fake) { throw 'SELFTEST_FOREIGN_GATEWAY_ACCEPTED' }
        Write-Output 'HOMEOFFICE_PAIR_SELFTEST=PASS'
        exit 0
    }
    if ([string]$env:COMPUTERNAME -notmatch '(?i)^desktop-5fvjmet$') { throw 'WRONG_PC_NOT_HOMEOFFICE' }

    $ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
    Assert-Ordinary $ProjectRoot $true
    Trusted-Git $ProjectRoot $origins
    $runtime = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    Assert-Ordinary $runtime $true
    Trusted-Git $runtime $runtimeOrigins
    Assert-Ordinary (Join-Path $runtime 'src\cli.js') $false
    Assert-Ordinary (Join-Path $runtime 'scripts\enroll-device.js') $false
    Assert-Ordinary (Join-Path $runtime 'node_modules\zod\package.json') $false
    $dirty = @(& git.exe -C $runtime status --porcelain=v1 --untracked-files=no)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'CODEBRIDGE_RUNTIME_DIRTY' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    Assert-Ordinary $node $false
    $nodeVersion = [string](& $node --version)
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'NODE24_REQUIRED' }

    if (Test-Path -LiteralPath $configFile) {
        Write-Output 'HOMEOFFICE_PAIR=EXISTING_PRIVATE_AGENT_USE_RECONNECT'
        exit 0
    }
    if (Test-Path -LiteralPath $enrollment) {
        Write-Output 'HOMEOFFICE_PAIR=EXISTING_PRIVATE_ENROLLMENT_REVIEW_REQUIRED'
        exit 2
    }

    # Do not create duplicate identities if this Home Office agent exists in
    # another known private store. Never display or copy its credentials.
    foreach ($store in @('E:\KMJ\private','E:\KMJ\CodeBridge-HomeOffice\private','D:\KMJ-HyperSpeed\private')) {
        if (!(Test-Path -LiteralPath $store -PathType Container)) { continue }
        $found = @(Get-ChildItem -LiteralPath $store -Filter 'agent.json' -File -Recurse -Depth 4 -ErrorAction SilentlyContinue)
        foreach ($file in $found) {
            try {
                if ($file.Length -gt 262144) { continue }
                Assert-Ordinary $file.FullName $false
                $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -ErrorAction Stop
                if ([string]$record.id -ceq $device -and @($record.projects | Where-Object { [string]$_.id -ceq $project }).Count -eq 1) { throw 'EXISTING_HOMEOFFICE_AGENT_RECONNECT_INSTEAD' }
            } catch {
                if ($_.Exception.Message -eq 'EXISTING_HOMEOFFICE_AGENT_RECONNECT_INSTEAD') { throw }
            }
        }
    }

    Check-Gateway
    Write-Output 'PUBLIC_AGENT_AUTH_CHALLENGE=PASS'
    Write-Output 'OWNER_PC_SCOPE=PASS'
    Write-Output 'CALIBRATION_ORIGIN=PASS'
    Write-Output 'CODEBRIDGE_RUNTIME=PASS'
    Write-Output 'PRODUCTION_PAIRING_FIX_DEPLOYED=NOT_VERIFIED'
    if ($CheckOnly) {
        Write-Output 'HOMEOFFICE_PAIR=DRY_RUN_NO_CREDENTIALS_CHANGED'
        exit 0
    }

    # Create only dedicated new private state, never overwrite enrollments.
    if (!(Test-Path -LiteralPath $private)) { $null = New-Item -ItemType Directory -Path $private -Force }
    if (!(Test-Path -LiteralPath $state)) { $null = New-Item -ItemType Directory -Path $state -Force }
    Private-Acl $private $true
    Private-Acl $state $true

    # Browser pairing approval is mandatory; this prints no bearer token.
    & $node (Join-Path $runtime 'scripts\enroll-device.js') $gateway $device $project $ProjectRoot $enrollment
    if ($LASTEXITCODE -ne 0) {
        Write-Output 'HOMEOFFICE_PAIR=BLOCKED_OWNER_APPROVAL_OR_PLATFORM_GATEWAY'
        exit 3
    }
    Private-Acl $enrollment $false
    $grant = Get-Content -LiteralPath $enrollment -Raw | ConvertFrom-Json
    if (!(Valid-Grant $grant)) { throw 'ENROLLMENT_IDENTITY_SCOPE_OR_GATEWAY_MISMATCH' }

    $cfg = @{
        gateway = $gateway + '/'
        id = $device
        tenant = [string]$grant.agent.tenant
        token = [string]$grant.agent.token
        stateDir = $state
        projects = @(@{
            id = $project
            root = $ProjectRoot
            writable = $true
            gates = @{}
            commandPresets = @('calibration-v4-software-qa')
        })
        license = @{ mode='free' }
    }
    $json = $cfg | ConvertTo-Json -Depth 14
    $stream = [IO.File]::Open($configFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
        $stream.Write($bytes,0,$bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    Private-Acl $configFile $false
    Write-Output 'HOMEOFFICE_PAIR=OWNER_APPROVED_PRIVATE_ENROLLMENT_SAVED'
    Write-Output 'ENROLLMENT_SECRETS_PRINTED=NO'

    # Entrust process/lock checks and fresh heartbeat to the existing launcher.
    $reconnect = Join-Path $PSScriptRoot 'CONNECT-CALIBRATION-PRO.ps1'
    & powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File $reconnect -ConfigPath $configFile
    if ($LASTEXITCODE -ne 0) { throw 'AGENT_RECONNECT_NEEDS_LOCAL_DIAGNOSTICS' }
    Write-Output 'ACCOUNT_SIDE_READY=CHECK_CONNECTION_OVERVIEW'
} catch {
    $reason = [string]$_.Exception.Message
    if ($reason -notmatch '^[A-Z][A-Z0-9_]{2,100}$') { $reason = 'PAIRING_LOCAL_PRECONDITION_OR_RUNTIME_ERROR' }
    Write-Output ('HOMEOFFICE_PAIR=BLOCKED:' + $reason)
    Write-Output 'OTHER_DEVICE_ENROLLMENTS=UNTOUCHED'
    Write-Output 'CALIBRATION_WORKTREE=UNTOUCHED'
    exit 2
}
