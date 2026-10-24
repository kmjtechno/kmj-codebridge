# KMJ CodeBridge — owner opt-in, current-user sign-in auto reconnect.
# One-click setup/reconnect; never registers services, scheduled tasks, or copies tokens.
[CmdletBinding()]
param(
    [ValidateSet('HomeOffice','P720')]
    [string]$Device = 'HomeOffice',
    [switch]$AtLogon,
    [switch]$RemoveAutoStart,
    [switch]$SelfTest
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$approvedOrigins = @(
    'https://github.com/kmjtechno/kmj-codebridge',
    'https://github.com/kmjtechno/kmj-codebridge.git',
    'git@github.com:kmjtechno/kmj-codebridge.git'
)
$expectedHost = if ($Device -eq 'HomeOffice') { 'DESKTOP-5FVJMET' } else { 'DESKTOP-K3AHHEM' }
$connectName = if ($Device -eq 'HomeOffice') { 'CONNECT-CALIBRATION-PRO.ps1' } else { 'CONNECT-P720-CODEBRIDGE.ps1' }
$pairName = 'PAIR-HOMEOFFICE-CALIBRATION.ps1'
$linkName = if ($Device -eq 'HomeOffice') {
    'KMJ CodeBridge HomeOffice Agent.lnk'
} else { 'KMJ CodeBridge P720 Agent.lnk' }
$scriptPath = $PSCommandPath

function RequireOrdinary([string]$Value,[bool]$Folder) {
    $item = Get-Item -LiteralPath $Value -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne $Folder) { throw 'AUTOCONNECT_INVALID_PATH_TYPE' }
    $cursor = $item
    if (!$Folder) { $cursor = $item.Directory }
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'AUTOCONNECT_REPARSE_PATH_DENIED'
        }
        $cursor = $cursor.Parent
    }
}
function ExpectPath([string]$a,[string]$b) {
    return [IO.Path]::GetFullPath($a).TrimEnd([char]92) -ieq
        [IO.Path]::GetFullPath($b).TrimEnd([char]92)
}
function ShortcutArgs([string]$AbsoluteScript,[string]$Scope) {
    if ($AbsoluteScript -notmatch '^[A-Za-z]:\\' -or
        $AbsoluteScript.Contains('"')) { throw 'AUTOCONNECT_SCRIPT_PATH_UNSAFE' }
    return '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' +
        $AbsoluteScript + '" -Device ' + $Scope + ' -AtLogon'
}
function VerifyShortcut($Shortcut,[string]$Exe,[string]$ExpectedArguments,[string]$WorkingDir) {
    return (ExpectPath ([string]$Shortcut.TargetPath) $Exe) -and
        ([string]$Shortcut.Arguments -ceq $ExpectedArguments) -and
        (ExpectPath ([string]$Shortcut.WorkingDirectory) $WorkingDir)
}
function CheckLegacyTask {
    if ($Device -ne 'P720') { return }
    # A separately configured boot task might already start this enrollment.
    # Never enable/disable/replace it or install a competing startup owner.
    $prior = Get-ScheduledTask -TaskName 'KMJ-CodeBridge-P720-Agent' -TaskPath '\' -ErrorAction SilentlyContinue
    if ($prior -and [string]$prior.State -ne 'Disabled') {
        throw 'AUTOCONNECT_EXISTING_P720_TASK_REVIEW_REQUIRED'
    }
}
function InvokeTrusted([string]$Target,[string[]]$Arguments,[bool]$Interactive) {
    RequireOrdinary $Target $false
    $systemPs = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    RequireOrdinary $systemPs $false
    $head = @('-NoProfile')
    if ($Interactive) { $head += '-STA' } else { $head += '-NonInteractive' }
    $head += @('-ExecutionPolicy','RemoteSigned','-File',$Target)
    # Filter child output to fixed status keys; no command lines or private paths.
    $lines = @(& $systemPs @head @Arguments 2>$null)
    $exit = $LASTEXITCODE
    $safe = @($lines | Where-Object {
        $_ -is [string] -and $_.Length -le 180 -and
        $_ -match '^(CALIBRATION_RECONNECT|DEVICE_CONNECT|HOMEOFFICE_PAIR|CALIBRATION_ENROLLMENT_DISCOVERY|NO_DUPLICATE_AGENT|DUPLICATE_AGENT_STARTED|ACCOUNT_GRANT|ENROLLMENT|OWNER_CHECKOUT|DIRTY_CHECKOUT)=[A-Z0-9_:]+$'
    })
    return [pscustomobject]@{ ExitCode = $exit; Lines = $safe }
}

try {
    if ($env:OS -cne 'Windows_NT') { throw 'AUTOCONNECT_WINDOWS_REQUIRED' }
    if ($SelfTest) {
        # Test the actual Windows .lnk roundtrip in a disposable test folder.
        # Never write the current user's Startup folder in CI.
        $fixture = Join-Path ([IO.Path]::GetTempPath()) ('kmj-link-fixture-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $fixture -ErrorAction Stop | Out-Null
        try {
            $shell = New-Object -ComObject WScript.Shell
            $dummy = Join-Path $fixture 'test.lnk'
            $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $args = ShortcutArgs $scriptPath $Device
            $shortcut = $shell.CreateShortcut($dummy)
            $shortcut.TargetPath = $ps
            $shortcut.Arguments = $args
            $shortcut.WorkingDirectory = $fixture
            $shortcut.Save()
            $actual = $shell.CreateShortcut($dummy)
            if (!(VerifyShortcut $actual $ps $args $fixture)) {
                $t = ExpectPath ([string]$actual.TargetPath) $ps
                $a = [string]$actual.Arguments -ceq $args
                $w = ExpectPath ([string]$actual.WorkingDirectory) $fixture
                Write-Output ('KMJ_SELFTEST_LINK_FLAGS=TARGET_' + [int][bool]$t + '_ARGS_' + [int][bool]$a + '_WORKDIR_' + [int][bool]$w)
                throw 'AUTOCONNECT_SELFTEST_SHORTCUT_INVALID'
            }
            if (VerifyShortcut $actual $ps ($args + ' -Unexpected') $fixture) {
                throw 'AUTOCONNECT_SELFTEST_TAMPER_ACCEPTED'
            }
            Write-Output 'KMJ_AUTOCONNECT_SELFTEST=PASS'
            Write-Output 'REAL_STARTUP_MODIFIED=NO'
        } finally {
            Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
        }
        exit 0
    }

    if ($env:COMPUTERNAME -ine $expectedHost) {
        throw 'AUTOCONNECT_WRONG_WINDOWS_DEVICE'
    }
    if ($scriptPath -notmatch '^[A-Za-z]:\\') {
        throw 'AUTOCONNECT_LOCAL_DRIVE_REQUIRED'
    }
    RequireOrdinary $scriptPath $false
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    RequireOrdinary $repo $true
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $origin = [string]((& $git -C $repo remote get-url origin 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $origin.Trim() -cnotin $approvedOrigins) {
        throw 'AUTOCONNECT_UNTRUSTED_CODEBRIDGE_ORIGIN'
    }
    $top = [string]((& $git -C $repo rev-parse --show-toplevel 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or !(ExpectPath $top $repo)) {
        throw 'AUTOCONNECT_NOT_CODEBRIDGE_ROOT'
    }
    $dirty = @(& $git --no-optional-locks -C $repo status --porcelain=v1 --untracked-files=no)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
        throw 'AUTOCONNECT_RUNTIME_TRACKED_CHANGES'
    }
    # A tracked-clean checkout must contain each executable script in HEAD.
    # Git --untracked-files=no alone cannot establish this provenance.
    $approvedScripts = @(
        'scripts/windows/ONE-CLICK-AGENT-AUTOCONNECT.ps1',
        ('scripts/windows/' + $connectName)
    )
    if ($Device -eq 'HomeOffice') {
        $approvedScripts += 'scripts/windows/PAIR-HOMEOFFICE-CALIBRATION.ps1'
    }
    $null = & $git -C $repo ls-files --error-unmatch -- @approvedScripts 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'AUTOCONNECT_UNTRACKED_LAUNCHER_SCRIPT'
    }
    if (!$RemoveAutoStart) { CheckLegacyTask }

    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    RequireOrdinary $ps $false
    $arguments = ShortcutArgs $scriptPath $Device
    $startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    if ([string]::IsNullOrWhiteSpace($startup)) {
        throw 'AUTOCONNECT_STARTUP_FOLDER_UNAVAILABLE'
    }
    RequireOrdinary $startup $true
    $shortcutPath = Join-Path $startup $linkName
    $shell = New-Object -ComObject WScript.Shell
    $existing = Test-Path -LiteralPath $shortcutPath
    if ($existing) {
        RequireOrdinary $shortcutPath $false
        $link = $shell.CreateShortcut($shortcutPath)
        if (!(VerifyShortcut $link $ps $arguments $repo)) {
            throw 'AUTOCONNECT_STARTUP_SHORTCUT_CONFLICT'
        }
    }
    if ($RemoveAutoStart) {
        if (!$existing) {
            Write-Output 'KMJ_AUTOCONNECT=ALREADY_DISABLED'
        } else {
            Remove-Item -LiteralPath $shortcutPath -ErrorAction Stop
            Write-Output 'KMJ_AUTOCONNECT=DISABLED_FOR_CURRENT_USER'
        }
        Write-Output 'PRIVATE_ENROLLMENT=UNCHANGED'
        exit 0
    }

    $connect = Join-Path $PSScriptRoot $connectName
    $extra = if ($Device -eq 'HomeOffice') { @('-AutoDiscover','-NoPicker') } else { @() }
    # A login task must NEVER pair/create a device. Existing already-approved
    # credentials stay in their original private file. No duplicate agent starts.
    $outcome = InvokeTrusted $connect $extra (!$AtLogon)
    foreach ($line in @($outcome.Lines)) { Write-Output $line }
    if ($outcome.ExitCode -ne 0 -and !$AtLogon -and $Device -eq 'HomeOffice' -and
        @($outcome.Lines) -contains 'CALIBRATION_ENROLLMENT_DISCOVERY=NO_MATCH_IN_KNOWN_PRIVATE_STORES') {
        $pair = Join-Path $PSScriptRoot $pairName
        Write-Output 'KMJ_AUTOCONNECT=OWNER_BROWSER_PAIRING_REQUIRED'
        $outcome = InvokeTrusted $pair @() $true
        foreach ($line in @($outcome.Lines)) { Write-Output $line }
    }
    if ($outcome.ExitCode -ne 0) {
        throw 'AUTOCONNECT_SCOPED_RECONNECT_NOT_VERIFIED'
    }
    Write-Output 'KMJ_AUTOCONNECT_AGENT=APPROVED_RECONNECT_COMMAND_SUCCEEDED'
    Write-Output 'ACCOUNT_CONNECTION=VERIFY_WITH_AUTHENTICATED_CODEBRIDGE_CLIENT'
    if ($AtLogon) {
        Write-Output 'KMJ_AUTOCONNECT=LOGON_RECONNECT_INVOKED'
        exit 0
    }
    if ($existing) {
        Write-Output 'KMJ_AUTOCONNECT=ALREADY_ENABLED'
    } else {
        $link = $shell.CreateShortcut($shortcutPath)
        $link.TargetPath = $ps
        $link.Arguments = $arguments
        $link.WorkingDirectory = $repo
        $link.Description = 'KMJ CodeBridge approved current-user agent reconnect'
        $link.WindowStyle = 7
        $link.Save()
        RequireOrdinary $shortcutPath $false
        $saved = $shell.CreateShortcut($shortcutPath)
        if (!(VerifyShortcut $saved $ps $arguments $repo)) {
            # Do not leave an unverified automatic entry.
            Remove-Item -LiteralPath $shortcutPath -ErrorAction SilentlyContinue
            throw 'AUTOCONNECT_SHORTCUT_POSTWRITE_VERIFICATION_FAILED'
        }
        Write-Output 'KMJ_AUTOCONNECT=ENABLED_AT_CURRENT_USER_LOGON'
    }
    Write-Output 'STARTS_BEFORE_WINDOWS_SIGN_IN=NO'
    Write-Output 'EXISTING_PRIVATE_ENROLLMENT=UNCHANGED'
    Write-Output 'OTHER_WINDOWS_AGENTS=UNTOUCHED'
} catch {
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^[A-Z][A-Z0-9_]{3,100}$') {
        $code = 'AUTOCONNECT_LOCAL_PRECONDITION_FAILED'
    }
    Write-Output ('KMJ_AUTOCONNECT=BLOCKED:' + $code)
    Write-Output 'OWNER_PROJECT_FILES=UNTOUCHED'
    Write-Output 'ENROLLMENT_SECRET_EXPORTED=NO'
    exit 2
}
