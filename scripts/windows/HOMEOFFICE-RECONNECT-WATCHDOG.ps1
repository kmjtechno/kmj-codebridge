# KMJ HomeOffice | current-user crash-reconnect watchdog.
# No browser pairing, external downloads, admin access, service or scheduled task.
[CmdletBinding()]
param([switch]$Install,[switch]$Run,[switch]$Remove,[switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedHost='DESKTOP-5FVJMET'
$linkName='KMJ CodeBridge P520 Recovery Watchdog.lnk'
$origins=@('https://github.com/kmjtechno/kmj-codebridge','https://github.com/kmjtechno/kmj-codebridge.git','git@github.com:kmjtechno/kmj-codebridge.git')
function StopSafe([string]$Reason) {
    Write-Output ('KMJ_P520_WATCHDOG=BLOCKED:'+$Reason)
    Write-Output 'PRIVATE_ENROLLMENT=UNCHANGED'
    exit 2
}
function Ordinary([string]$Path,[bool]$Directory) {
    $item=Get-Item -LiteralPath $Path -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne $Directory) { throw 'WATCHDOG_PATH_TYPE' }
    $cur=if ($Directory) {$item} else {$item.Directory}
    while ($null -ne $cur) {
        if ($cur.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'WATCHDOG_REPARSE_DENIED' }
        $cur=$cur.Parent
    }
}
function Matches($Shortcut,[string]$Exe,[string]$Args,[string]$Root) {
    return [string]::Equals($Shortcut.TargetPath,$Exe,[StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($Shortcut.Arguments,$Args,[StringComparison]::Ordinal) -and
        [string]::Equals($Shortcut.WorkingDirectory,$Root,[StringComparison]::OrdinalIgnoreCase)
}
try {
    if ($SelfTest) {
        if ($linkName -ne 'KMJ CodeBridge P520 Recovery Watchdog.lnk') { throw 'WATCHDOG_SELFTEST' }
        Write-Output 'KMJ_P520_WATCHDOG_SELFTEST=PASS'
        Write-Output 'REAL_STARTUP_MODIFIED=NO'
        exit 0
    }
    if (([int][bool]$Install+[int][bool]$Run+[int][bool]$Remove) -ne 1) {
        throw 'WATCHDOG_MODE_REQUIRED'
    }
    if ($env:OS -cne 'Windows_NT' -or $env:COMPUTERNAME -ine $expectedHost) {
        throw 'WATCHDOG_WRONG_HOST'
    }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=[Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'WATCHDOG_ADMIN_NOT_ALLOWED'
    }
    $scriptPath=$PSCommandPath
    Ordinary $scriptPath $false
    $repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    Ordinary $repo $true
    $oneclick=Join-Path $repo 'scripts\windows\ONE-CLICK-AGENT-AUTOCONNECT.ps1'
    Ordinary $oneclick $false
    $git=(Get-Command git.exe -ErrorAction Stop).Source
    Ordinary $git $false
    $remote=[string]((& $git -C $repo remote get-url origin 2>$null)|Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $remote.Trim() -cnotin $origins) {
        throw 'WATCHDOG_UNTRUSTED_ORIGIN'
    }
    $top=[string]((& $git -C $repo rev-parse --show-toplevel 2>$null)|Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or ![string]::Equals([IO.Path]::GetFullPath($top),$repo,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'WATCHDOG_UNTRUSTED_ROOT'
    }
    $null=& $git -C $repo ls-files --error-unmatch -- 'scripts/windows/HOMEOFFICE-RECONNECT-WATCHDOG.ps1' 'scripts/windows/ONE-CLICK-AGENT-AUTOCONNECT.ps1' 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'WATCHDOG_UNTRACKED_SOURCE' }
    $dirty=@(& $git --no-optional-locks -C $repo status --porcelain=v1 --untracked-files=no 2>$null)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) { throw 'WATCHDOG_DIRTY_RUNTIME' }
    $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Ordinary $ps $false
    $startup=[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    if ([string]::IsNullOrWhiteSpace($startup)) { throw 'WATCHDOG_STARTUP_UNAVAILABLE' }
    Ordinary $startup $true
    $shortcutPath=Join-Path $startup $linkName
    if ($scriptPath.Contains('"')) { throw 'WATCHDOG_PATH_QUOTES' }
    $arguments='-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "'+$scriptPath+'" -Run'
    $shell=New-Object -ComObject WScript.Shell
    $exists=Test-Path -LiteralPath $shortcutPath
    if ($exists) {
        Ordinary $shortcutPath $false
        if (!(Matches ($shell.CreateShortcut($shortcutPath)) $ps $arguments $repo)) {
            throw 'WATCHDOG_SHORTCUT_CONFLICT'
        }
    }
    if ($Remove) {
        if ($exists) {
            Remove-Item -LiteralPath $shortcutPath -ErrorAction Stop
            Write-Output 'KMJ_P520_WATCHDOG=REMOVED_CURRENT_USER_ONLY'
        } else { Write-Output 'KMJ_P520_WATCHDOG=ALREADY_DISABLED' }
        Write-Output 'EXISTING_AGENT=UNTOUCHED'
        exit 0
    }
    if ($Install) {
        # -AtLogon never invokes pairing; existing scoped credentials must work.
        & $ps -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $oneclick -Device HomeOffice -AtLogon 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'WATCHDOG_APPROVED_RECONNECT_REQUIRED' }
        if (!$exists) {
            $link=$shell.CreateShortcut($shortcutPath)
            $link.TargetPath=$ps
            $link.Arguments=$arguments
            $link.WorkingDirectory=$repo
            $link.WindowStyle=7
            $link.Description='KMJ approved current-user HomeOffice recovery'
            $link.Save()
            Ordinary $shortcutPath $false
            if (!(Matches ($shell.CreateShortcut($shortcutPath)) $ps $arguments $repo)) {
                Remove-Item -LiteralPath $shortcutPath -ErrorAction SilentlyContinue
                throw 'WATCHDOG_SHORTCUT_VERIFY'
            }
        }
        Start-Process -FilePath $ps -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -ErrorAction Stop | Out-Null
        Write-Output 'KMJ_P520_WATCHDOG=INSTALLED_CURRENT_USER_ONLY'
        Write-Output 'BEFORE_WINDOWS_LOGIN=NOT_AVAILABLE'
        Write-Output 'ACCOUNT_READY=VERIFY_AUTHENTICATED'
        exit 0
    }
    $mutex=[System.Threading.Mutex]::new($false,'Local\KMJ-CodeBridge-P520-Watchdog')
    $owned=$false
    try {
        try { $owned=$mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned=$true }
        if (!$owned) { Write-Output 'KMJ_P520_WATCHDOG=ALREADY_RUNNING'; exit 0 }
        while (Test-Path -LiteralPath $shortcutPath) {
            Ordinary $shortcutPath $false
            if (!(Matches ($shell.CreateShortcut($shortcutPath)) $ps $arguments $repo)) { break }
            # The trusted one-click helper performs its own clean-Git and grant checks.
            # A failed reconnect never grants device access; retry only while signed in.
            & $ps -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $oneclick -Device HomeOffice -AtLogon 2>$null | Out-Null
            Start-Sleep -Seconds 180
        }
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
    Write-Output 'KMJ_P520_WATCHDOG=EXITED_WITHOUT_STOPPING_AGENT'
    exit 0
} catch {
    $reason=[string]$_.Exception.Message
    if ($reason -notmatch '^WATCHDOG_[A-Z0-9_]{3,100}$') { $reason='WATCHDOG_LOCAL_PREFLIGHT' }
    StopSafe $reason
}
