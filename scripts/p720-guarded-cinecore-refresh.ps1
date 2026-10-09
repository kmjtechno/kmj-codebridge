# Scoped P720 CineCore worker refresh. Private credentials never leave this workstation.
# Does not modify CineCore source, use generic shell MCP, or auto-upgrade entitlements.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = 'D:\KMJ-HyperSpeed'
$repo = Join-Path $root 'projects\kmj-codebridge'
$project = Join-Path $root 'projects\kmj-cinecore'
$private = Join-Path $root 'private\p720-cinecore'
$config = Join-Path $private 'agent.json'
$state = Join-Path $private 'state'
$store = Join-Path $root 'runtime\codebridge-cinecore'
$marker = Join-Path $private 'current-runtime.json'
$report = Join-Path $root 'P720-CINECORE-SAFE-REFRESH-RESULT.txt'
$device = 'kmj-p720-cinecore-' + ($env:COMPUTERNAME -replace '[^A-Za-z0-9_-]', '-').ToLowerInvariant()
if ($device.Length -gt 64) { $device = $device.Substring(0, 64) }

function Status([string]$kind, [string]$value) {
    $line = '{0}: {1}' -f $kind, $value
    Write-Host $line
    Add-Content -LiteralPath $report -Value $line -Encoding UTF8
}
function Git([string[]]$argsList) {
    $value = @(& git.exe @argsList 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Fixed-argument Git validation failed.' }
    return ($value -join [Environment]::NewLine).Trim()
}
function Check-Idle {
    $dir = Join-Path $state 'jobs'
    if (!(Test-Path -LiteralPath $dir)) { throw 'Job journal absent, idle state cannot be proven.' }
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -Force -Filter '*.json')) {
        if ($f.Length -gt 131072 -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Untrusted job journal entry; refusing restart.'
        }
        try { $j = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json }
        catch { throw 'Corrupt job journal; refusing restart.' }
        if ([string]$j.state -in @('running','queued','')) {
            throw 'Active, queued or unknown CineCore job. No restart performed.'
        }
    }
}
function Matches {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($config) -and
        $_.CommandLine -match 'src[\\/]cli\.js' -and $_.CommandLine -match '\bagent\b'
    })
}
function Check-Owner([object]$proc, [string]$node) {
    if ([string]$proc.ExecutablePath -ine $node) { throw 'Agent executable mismatch.' }
    $lock = Join-Path $state 'agent.lock'
    if (!(Test-Path -LiteralPath $lock)) { throw 'Agent lock missing.' }
    try { $owner = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json }
    catch { throw 'Malformed agent lock.' }
    if ([int]$owner.pid -ne [int]$proc.ProcessId -or [string]$owner.owner -eq '') {
        throw 'Agent process and private lock PID disagree.'
    }
}
function Stop-Owned([object]$proc, [string]$node) {
    Check-Idle
    $same = @(Matches)
    if ($same.Count -ne 1 -or $same[0].ProcessId -ne $proc.ProcessId) {
        throw 'Agent identity changed during restart. Refusing stop.'
    }
    Check-Owner $same[0] $node
    # Windows Stop-Process is a hard stop; only do this after two idle checks.
    Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction Stop
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 250
        if (!(Get-Process -Id ([int]$proc.ProcessId) -ErrorAction SilentlyContinue)) { return }
    }
    throw 'Previous agent did not exit. Refusing duplicate agent startup.'
}
function Start-Owned([string]$dir, [string]$node, [string]$prefix) {
    $logdir = Join-Path $root 'logs'
    return Start-Process -FilePath $node -WorkingDirectory $dir -ArgumentList @('src/cli.js','agent',$config) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logdir ($prefix+'-out.log')) -RedirectStandardError (Join-Path $logdir ($prefix+'-err.log'))
}
function Wait-Connected([object]$process, [datetime]$since) {
    $signal = Join-Path $state 'connection-status.json'
    for ($i=0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 1
        $process.Refresh()
        if ($process.HasExited) { return $false }
        if (!(Test-Path -LiteralPath $signal)) { continue }
        try {
            $record = Get-Content -LiteralPath $signal -Raw | ConvertFrom-Json
            $stamp = [datetime]::Parse([string]$record.observedAt).ToUniversalTime()
            if ($record.status -eq 'connected' -and $stamp -gt $since) {
                return $true
            }
        } catch { }
    }
    return $false
}
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Windows P720 required.' }
    New-Item -ItemType Directory -Path $root, (Join-Path $root 'logs'), $store -Force | Out-Null
    Set-Content -LiteralPath $report -Value 'KMJ P720 CINECORE — SAFE STAGED REFRESH; PRIVATE CREDENTIALS NOT INCLUDED' -Encoding UTF8
    Status 'INFO' ('RUN_UTC=' + [DateTime]::UtcNow.ToString('o'))
    if (!(Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw 'CodeBridge Git checkout missing.' }
    if ((Get-Item -LiteralPath $repo).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CodeBridge checkout linked.' }
    if ((Get-Item -LiteralPath $store).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime store linked.' }
    if ((Git -argsList @('-C',$repo,'remote','get-url','origin')) -cnotin @('https://github.com/kmjtechno/kmj-codebridge.git','https://github.com/kmjtechno/kmj-codebridge','git@github.com:kmjtechno/kmj-codebridge.git')) { throw 'Untrusted Git origin.' }
    if ((Git -argsList @('-C',$repo,'branch','--show-current')) -cne 'main') { throw 'CodeBridge branch is not main.' }
    if ((Git -argsList @('-C',$repo,'status','--porcelain')) -ne '') { throw 'CodeBridge checkout has edits; refusing update.' }
    $revision = Git -argsList @('-C',$repo,'rev-parse','HEAD')
    if ($revision -cnotmatch '^[a-f0-9]{40}$') { throw 'Bad CodeBridge commit.' }
    $cfg = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    if ([string]$cfg.id -cne $device -or [string]$cfg.gateway -ne 'https://kmjtechno.com/' -or
        [string]$cfg.tenant -eq '' -or [string]$cfg.token -eq '' -or
        [string]$cfg.stateDir -ne $state -or [string]$cfg.license.mode -ne 'free' -or
        @($cfg.projects).Count -ne 1 -or
        [string]$cfg.projects[0].id -cne 'kmj-cinecore' -or
        [string]$cfg.projects[0].root -ne $project) {
        throw 'Approved one-project CineCore enrollment mismatch.'
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    if ([int]((& $node --version).Trim() -replace '^v([0-9]+).*$', '$1') -lt 24) { throw 'Node24+ required.' }
    $dest = Join-Path $store ('revision-' + $revision)
    $old = $repo
    if (Test-Path -LiteralPath $marker) {
        $prev = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
        if ([string]$prev.revision -cnotmatch '^[a-f0-9]{40}$') { throw 'Saved runtime marker corrupt.' }
        $old = Join-Path $store ('revision-' + [string]$prev.revision)
        if (!(Test-Path -LiteralPath (Join-Path $old 'src\cli.js'))) { throw 'Previous runtime missing.' }
    }
    if (Test-Path -LiteralPath $dest) {
        if ((Get-Item -LiteralPath $dest).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Staged runtime linked.' }
        if ((Git -argsList @('-C',$dest,'status','--porcelain')) -ne '') { throw 'Staged runtime has edits; refusing reuse.' }
    } else {
        Status 'INFO' 'Staging a new revision outside the running checkout.'
        & git.exe clone -q --no-hardlinks --no-checkout --single-branch --branch main $repo $dest
        if ($LASTEXITCODE -ne 0) { throw 'Local staging clone failed.' }
        & git.exe -C $dest -c core.hooksPath=NUL checkout -q --detach $revision
        if ($LASTEXITCODE -ne 0) { throw 'Staged revision checkout failed.' }
    }
    if ((Git -argsList @('-C',$dest,'rev-parse','HEAD')) -cne $revision) { throw 'Staged revision mismatch.' }
    & npm.cmd --prefix $dest ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Pinned install failed; old agent untouched.' }
    & npm.cmd --prefix $dest run check
    if ($LASTEXITCODE -ne 0) { throw 'CodeBridge checks failed; old agent untouched.' }
    & npm.cmd --prefix $dest test
    if ($LASTEXITCODE -ne 0) { throw 'CodeBridge tests failed; old agent untouched.' }
    Status 'PASS' ('Staged runtime check+tests PASS at '+$revision)
    Check-Idle
    $candidates = @(Matches)
    if ($candidates.Count -gt 1) { throw 'Multiple CineCore agents: refused.' }
    if ($candidates.Count -eq 1) {
        Check-Owner $candidates[0] $node
        Start-Sleep -Seconds 2
        Stop-Owned $candidates[0] $node
        Status 'INFO' 'Only exact idle CineCore agent stopped.'
    } else {
        $lock = Join-Path $state 'agent.lock'
        if (Test-Path -LiteralPath $lock) {
            try { $prior = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json }
            catch { throw 'Ambiguous offline agent lock.' }
            if (Get-Process -Id ([int]$prior.pid) -ErrorAction SilentlyContinue) {
                throw 'Agent lock still owned: refused duplicate startup.'
            }
        }
    }
    $started = [DateTime]::UtcNow
    $new = Start-Owned $dest $node 'p720-cinecore-refreshed'
    if (!(Wait-Connected $new $started)) {
        Status 'WARN' 'New runtime did not produce fresh authenticated heartbeat; rollback attempt.'
        $new.Refresh()
        if (!$new.HasExited) { Stop-Owned $new $node }
        $rollbackSince = [DateTime]::UtcNow
        $rollback = Start-Owned $old $node 'p720-cinecore-rollback'
        if (!(Wait-Connected $rollback $rollbackSince)) {
            throw 'New and previous runtime both failed heartbeat. Local diagnostics required.'
        }
        throw 'New runtime rejected; previous runtime restarted and gateway-authenticated.'
    }
    Set-Content -LiteralPath $marker -Value (@{ revision=$revision; updatedUtc=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress) -Encoding UTF8
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $marker /inheritance:r /grant:r ('*' + $sid + ':F') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'New runtime online, but marker ACL needs correction.' }
    Status 'PASS' ('Refreshed CineCore CodeBridge gateway heartbeat at '+$revision)
    Status 'NEXT' 'Verify device grant and project snapshot in ChatGPT/Claude after refresh.'
} catch {
    if (Test-Path -LiteralPath $report) { Status 'BLOCKED' ([string]$_.Exception.Message) }
    else { Write-Host ('BLOCKED: ' + $_.Exception.Message) }
    exit 2
}
