# KMJ TECHNO - isolated Windows IDE CodeBridge enrollment
# Requires explicit browser consent; never touches CodeBridge or CineCore credentials.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$base = 'D:\KMJ-HyperSpeed'
$ide = Join-Path $base 'projects\kmj-autonomous-cloud-ide'
$existingCodebridge = Join-Path $base 'projects\kmj-codebridge'
$private = Join-Path $base 'private\p720-ide'
$state = Join-Path $private 'state'
$enrollment = Join-Path $private 'enrollment.json'
$config = Join-Path $private 'agent.json'
$logs = Join-Path $base 'logs'
$report = Join-Path $base 'P720-IDE-AUTH-RESULT.txt'
$projectId = 'kmj-autonomous-cloud-ide'
$deviceId = 'kmj-p720-ide-' + ($env:COMPUTERNAME -replace '[^A-Za-z0-9_-]', '-').ToLowerInvariant()
if ($deviceId.Length -gt 64) { $deviceId = $deviceId.Substring(0,64) }

function Report([string]$level, [string]$message) {
    $line = ('{0}: {1}' -f $level, $message)
    Write-Host $line
    Add-Content -LiteralPath $report -Value $line -Encoding UTF8
}
function Protect-Folder([string]$folder) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $folder /inheritance:r /grant:r ('*' + $sid + ':(OI)(CI)F') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PRIVATE_FOLDER_ACL_FAILED' }
}
function Protect-File([string]$file) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $file /inheritance:r /grant:r ('*' + $sid + ':F') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PRIVATE_FILE_ACL_FAILED' }
}
function Confirm-Origin([string]$root, [string]$expected) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw ('MISSING_CHECKOUT:' + $expected)
    }
    if (((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('REPARSE_ROOT_NOT_ALLOWED:' + $expected)
    }
    $urls = @(& git -C $root remote get-url origin)
    if ($LASTEXITCODE -ne 0 -or $urls.Count -ne 1) {
        throw ('UNVERIFIED_ORIGIN:' + $expected)
    }
    $valid = @(
        ('https://github.com/kmjtechno/' + $expected),
        ('https://github.com/kmjtechno/' + $expected + '.git'),
        ('git@github.com:kmjtechno/' + $expected + '.git')
    )
    if ($urls[0].Trim() -cnotin $valid) {
        throw ('UNTRUSTED_ORIGIN:' + $expected)
    }
}
function Find-IDEAgent {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object {
            $_.CommandLine -and $_.CommandLine.Contains($config) -and
            $_.CommandLine -match 'src[\\/]cli\.js' -and
            $_.CommandLine -match '\bagent\b'
        })
}
try {
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
    if (-not (Test-Path -LiteralPath 'D:\')) { throw 'D_DRIVE_REQUIRED' }
    New-Item -ItemType Directory -Path $base, $logs -Force | Out-Null
    Set-Content -LiteralPath $report -Value 'KMJ IDE CODEBRIDGE - CREDENTIAL-FREE REPORT' -Encoding UTF8
    Report 'INFO' ('RUN_UTC=' + [DateTime]::UtcNow.ToString('o'))
    Report 'INFO' ('IDE_DEVICE=' + $deviceId + ' PROJECT=' + $projectId)
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $version = (& $node --version).Trim()
    if ([int]($version -replace '^v([0-9]+).*$', '$1') -lt 24) { throw 'NODE_24_REQUIRED' }
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'GIT_REQUIRED' }

    Confirm-Origin $ide 'kmj-autonomous-cloud-ide'
    $branch = (& git -C $ide branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'kmj/v29-universal-router') {
        throw 'IDE_BRANCH_UNEXPECTED'
    }
    $changes = @(& git -C $ide status --porcelain=v1)
    if ($LASTEXITCODE -ne 0 -or $changes.Count -gt 0) {
        throw 'IDE_CHECKOUT_DIRTY_NO_FILES_CHANGED'
    }
    Report 'PASS' 'IDE checkout verified (tracked/untracked status clean); LFS binaries NOT verified.'

    # Reuse the already-installed, standalone recovery runtime if available.
    # Never install npm packages in the owner's dirty CodeBridge checkout.
    $candidates = @()
    $releaseDir = Join-Path $base 'codebridge-releases'
    if (Test-Path -LiteralPath $releaseDir) {
        $candidates += @(Get-ChildItem -LiteralPath $releaseDir -Directory -Filter 'agent-recovery-*' |
            Sort-Object LastWriteTime -Descending | Select-Object -ExpandProperty FullName)
    }
    $candidates += $existingCodebridge
    $runtime = $null
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath (Join-Path $candidate 'src\cli.js'))) { continue }
        if (-not (Test-Path -LiteralPath (Join-Path $candidate 'scripts\enroll-device.js'))) { continue }
        if (-not (Test-Path -LiteralPath (Join-Path $candidate 'node_modules\zod\package.json'))) { continue }
        try {
            Confirm-Origin $candidate 'kmj-codebridge'
            $runtime = $candidate
            break
        } catch { continue }
    }
    if (-not $runtime) { throw 'NO_INSTALLED_TRUSTED_CODEBRIDGE_RUNTIME' }
    Report 'PASS' 'Reused installed CodeBridge runtime without source updates.'

    New-Item -ItemType Directory -Path $private, $state -Force | Out-Null
    Protect-Folder $private
    Protect-Folder $state
    if (-not (Test-Path -LiteralPath $config)) {
        if (-not (Test-Path -LiteralPath $enrollment)) {
            Report 'ACTION' 'Approve the NEW IDE device/project and read/write/execute in your KMJ browser.'
            & $node (Join-Path $runtime 'scripts\enroll-device.js') 'https://kmjtechno.com' $deviceId $projectId $ide $enrollment
            if ($LASTEXITCODE -ne 0) { throw 'IDE_ENROLLMENT_PENDING_DENIED_OR_EXPIRED' }
        }
        Protect-File $enrollment
        $grant = Get-Content -LiteralPath $enrollment -Raw | ConvertFrom-Json
        if ([string]$grant.agent.id -cne $deviceId -or
            [string]$grant.agent.tenant -eq '' -or
            [string]$grant.agent.token -eq '' -or
            @($grant.projects).Count -ne 1 -or
            [string]$grant.projects[0].id -cne $projectId) {
            throw 'IDE_GRANT_IDENTITY_OR_PROJECT_MISMATCH'
        }
        foreach ($permission in @('read','write','execute')) {
            if (@($grant.permissions) -cnotcontains $permission) { throw 'GRANT_PERMISSION_MISMATCH' }
        }
        $returned = [string]$grant.gateway
        # Never rebind a newly issued credential across gateway origins.
        if ($returned -ne '' -and $returned.TrimEnd('/') -ne 'https://kmjtechno.com') {
            throw 'ENROLLMENT_GATEWAY_MISMATCH'
        }

        $tempBuild = Join-Path $base 'tmp\ide-build'
        $gates = @{
            ide_rust_check = @{ command = 'cargo.exe'; args = @('check','--locked','--manifest-path','rust-core/Cargo.toml'); timeoutMs = 300000 }
            ide_rust_release = @{ command = 'cargo.exe'; args = @('build','--locked','--release','--manifest-path','rust-core/Cargo.toml'); timeoutMs = 300000 }
            ide_install_dependencies = @{ command = 'npm.cmd'; args = @('ci','--no-audit','--no-fund'); timeoutMs = 300000 }
            ide_typecheck = @{ command = 'npm.cmd'; args = @('run','typecheck-client'); timeoutMs = 300000 }
            ide_windows_package = @{ command = 'powershell.exe'; args = @('-NoProfile','-NonInteractive','-File','scripts/build-kmj-win32-release.ps1','-BuildTemp',$tempBuild); timeoutMs = 300000 }
        }
        $cfg = @{
            gateway = 'https://kmjtechno.com/'
            token = [string]$grant.agent.token
            id = $deviceId
            tenant = [string]$grant.agent.tenant
            stateDir = $state
            projects = @(@{ id = $projectId; root = $ide; writable = $true; gates = $gates })
            license = @{ mode = 'free' }
        }
        if (Test-Path -LiteralPath $config) { throw 'PRIVATE_CONFIG_CREATED_CONCURRENTLY' }
        [IO.File]::WriteAllText($config, ($cfg | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
        Protect-File $config
        Report 'PASS' 'Separately approved IDE credential saved to private ACL-controlled file.'
    } else {
        Protect-File $config
        $prior = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
        if ([string]$prior.id -cne $deviceId -or
            [string]$prior.token -eq '' -or [string]$prior.tenant -eq '' -or
            [string]$prior.gateway -ne 'https://kmjtechno.com/' -or
            [string]$prior.stateDir -cne $state -or
            [string]$prior.license.mode -ne 'free' -or
            @($prior.projects).Count -ne 1 -or
            [string]$prior.projects[0].id -cne $projectId -or
            [string]$prior.projects[0].root -cne $ide) {
            throw 'EXISTING_IDE_CONFIG_SCOPE_MISMATCH_NO_OVERWRITE'
        }
        Report 'PASS' 'Existing IDE credential scope verified; no re-enrollment.'
    }

    $running = @(Find-IDEAgent)
    if ($running.Count -gt 1) { throw 'MULTIPLE_SCOPED_IDE_AGENTS' }
    if ($running.Count -eq 1) {
        Report 'PASS' ('IDE agent already running PID=' + $running[0].ProcessId)
    } else {
        $started = [DateTime]::UtcNow
        $p = Start-Process -FilePath $node -ArgumentList @('src/cli.js','agent',$config) -WorkingDirectory $runtime -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'p720-ide-agent-out.log') -RedirectStandardError (Join-Path $logs 'p720-ide-agent-err.log') -PassThru
        Report 'INFO' ('IDE agent launched PID=' + $p.Id)
        $connection = Join-Path $state 'connection.json'
        $online = $false
        for ($i=0; $i -lt 20; $i++) {
            Start-Sleep -Seconds 2
            $p.Refresh()
            if ($p.HasExited) { throw 'IDE_AGENT_EXITED_SEE_LOCAL_LOGS' }
            if (Test-Path -LiteralPath $connection) {
                try {
                    $stamp = [DateTime]::Parse((Get-Content -LiteralPath $connection -Raw | ConvertFrom-Json).connectedAt).ToUniversalTime()
                    if ($stamp -ge $started.AddSeconds(-2)) { $online = $true; break }
                } catch { }
            }
        }
        if ($online) { Report 'PASS' 'Authenticated IDE agent gateway heartbeat.' }
        else { Report 'WARN' 'IDE agent running but heartbeat not confirmed.' }
    }
    Report 'NEXT' 'CodeBridge tools can now inspect the IDE scope and run named gates after account grant confirmation.'
    Report 'NEXT' 'Only share P720-IDE-AUTH-RESULT.txt. NEVER share private/p720-ide files.'
} catch {
    if (Test-Path -LiteralPath $report) {
        Report 'BLOCKED' ([string]$_.Exception.Message)
    } else {
        Write-Host ('BLOCKED: ' + $_.Exception.Message)
    }
    exit 2
}
