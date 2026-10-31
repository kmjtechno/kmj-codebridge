# KMJ P520 llama.cpp — OWNER-EXECUTED READ-ONLY ATTESTATION
# No downloads, deletion, service control, environment updates, configuration changes or prompts.
[CmdletBinding()]
param([switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$expectedModelHash='03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'
$root=Join-Path $env:LOCALAPPDATA 'KMJ-LocalCodingAI'
$model=Join-Path $root 'models\Qwen3.5-9B-Q4_K_M.gguf'
$cuda=Join-Path $root 'runtime\b11998\cuda12'
function Mark([string]$name,[string]$value) { Write-Output ($name+'='+$value) }
function CheckNode([string]$name,[bool]$isFile) {
    if($isFile) {
        if(!(Test-Path -LiteralPath $name -PathType Leaf)) { throw 'REQUIRED_FILE_MISSING' }
    } elseif(!(Test-Path -LiteralPath $name -PathType Container)) { throw 'REQUIRED_DIRECTORY_MISSING' }
    if(((Get-Item -LiteralPath $name -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'REPARSE_POINT_BLOCKED'
    }
}

# Bounded component-by-component discovery: no recursive unbounded Get-ChildItem.
function Find-BoundedServerBinary([string]$base) {
    $pending=New-Object 'System.Collections.Queue'
    $pending.Enqueue(@($base,0))
    $seen=0
    $found=New-Object 'System.Collections.Generic.List[string]'
    while($pending.Count -gt 0) {
        $node=$pending.Dequeue()
        $folder=[string]$node[0]
        $depth=[int]$node[1]
        Get-ChildItem -LiteralPath $folder -Force -ErrorAction Stop | ForEach-Object {
            $seen++
            if($seen -gt 128) { throw 'BINARY_DISCOVERY_LIMIT' }
            if(($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'REPARSE_POINT_BLOCKED'
            }
            if($_.PSIsContainer) {
                if($depth -ge 3) { throw 'BINARY_DISCOVERY_DEPTH' }
                $pending.Enqueue(@([string]$_.FullName,($depth+1)))
            } elseif($_.Name -ieq 'llama-server.exe') {
                $found.Add([string]$_.FullName)
            }
        }
    }
    if($found.Count -ne 1) { throw 'SERVER_BINARY_AMBIGUOUS' }
    return $found[0]
}
function Assert-ServerArguments([string]$line,[string]$modelPath) {
    # Reject duplicate or unsupported forms, rather than matching a path in
    # unrelated --alias or --log-file arguments.
    $flagPattern='(?i)(?:^|\s)(--model|-m|--host|--port)(?=\s|=|$)'
    $argPattern='(?i)(?:^|\s)(--model|-m|--host|--port)\s+(?:"([^"]+)"|(\S+))(?=\s|$)'
    $all=[regex]::Matches($line,$flagPattern)
    $parsed=[regex]::Matches($line,$argPattern)
    if($all.Count -ne 3 -or $parsed.Count -ne 3) { throw 'SERVER_COMMAND_LINE_MISMATCH' }
    $values=@{}
    foreach($match in $parsed) {
        $key=$match.Groups[1].Value.ToLowerInvariant()
        if($key -eq '-m') { $key='--model' }
        if($values.ContainsKey($key)) { throw 'SERVER_COMMAND_LINE_MISMATCH' }
        $value=$match.Groups[2].Value
        if(-not $match.Groups[2].Success) { $value=$match.Groups[3].Value }
        $values[$key]=$value
    }
    if($values.Count -ne 3 -or
       $values['--model'] -ine $modelPath -or
       $values['--host'] -cne '127.0.0.1' -or
       $values['--port'] -cne '20145') {
        throw 'SERVER_COMMAND_LINE_MISMATCH'
    }
}
if($SelfTest) {
    $m='C:\KMJ Models\Qwen3.5-9B-Q4_K_M.gguf'
    $good='"C:\Program Files\llama-server.exe" --model "'+$m+'" --host 127.0.0.1 --port 20145'
    Assert-ServerArguments $good $m
    $bad=@(
        ('llama-server.exe --model C:\other.gguf --alias "'+$m+'" --host 127.0.0.1 --port 20145'),
        ($good+' --model C:\other.gguf'),
        ($good+' --host 0.0.0.0'),
        ($good+' --port 20146'),
        ('llama-server.exe --model="'+$m+'" --host 127.0.0.1 --port 20145'),
        ('llama-server.exe --host 127.0.0.1 --port 20145 --alias "'+$m+'"')
    )
    foreach($candidate in $bad) {
        $blocked=$false
        try { Assert-ServerArguments $candidate $m } catch { $blocked=$true }
        if(-not $blocked) { throw 'SELFTEST_NEGATIVE_ACCEPTED' }
    }
    Mark 'P520_ATTEST_V2_SELFTEST' 'PASS'
    exit 0
}

try {
    if($env:OS -cne 'Windows_NT' -or $env:COMPUTERNAME -ine 'DESKTOP-5FVJMET' -or
        (-not [Environment]::Is64BitOperatingSystem)) { throw 'WRONG_DEVICE' }
    $pc=Get-CimInstance Win32_ComputerSystem
    if($pc.Manufacturer -notmatch '(?i)lenovo' -or [string]$pc.Model -cne '30BFS1JG13') { throw 'HARDWARE_ID_MISMATCH' }
    CheckNode $root $false
    CheckNode (Join-Path $root 'models') $false
    CheckNode (Join-Path $root 'runtime') $false
    CheckNode (Join-Path $root 'runtime\b11998') $false
    CheckNode $cuda $false
    CheckNode $model $true
    if((Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash -ine $expectedModelHash) {
        throw 'MODEL_SHA256_MISMATCH'
    }
    $exe=Find-BoundedServerBinary $cuda
    CheckNode $exe $true
    $sockets=@(Get-NetTCPConnection -LocalPort 20145 -State Listen -ErrorAction Stop)
    if($sockets.Count -ne 1 -or [string]$sockets[0].LocalAddress -cne '127.0.0.1') {
        throw 'UNSAFE_OR_AMBIGUOUS_LISTENER'
    }
    $pidLocal=[int]$sockets[0].OwningProcess
    if($pidLocal -lt 1) { throw 'INVALID_SERVER_PID' }
    $owner=Get-CimInstance Win32_Process -Filter ("ProcessId="+$pidLocal)
    if($null -eq $owner -or [string]$owner.ExecutablePath -ine $exe) {
        throw 'SERVER_BINARY_IDENTITY_MISMATCH'
    }
    $cmdline=[string]$owner.CommandLine
    Assert-ServerArguments $cmdline $model
    $health=Invoke-RestMethod 'http://127.0.0.1:20145/health' -TimeoutSec 8
    $reported=Invoke-RestMethod 'http://127.0.0.1:20145/v1/models' -TimeoutSec 8
    if([string]$health.status -cne 'ok' -or
       @($reported.data).Count -ne 1 -or
       [IO.Path]::GetFileName([string]$reported.data[0].id) -cne 'Qwen3.5-9B-Q4_K_M.gguf') {
        throw 'MODEL_OR_HEALTH_MISMATCH'
    }
    # Bind the post-HTTP listener to the same process identity. This is
    # read-only evidence, not protected launcher or publisher approval.
    $after=@(Get-NetTCPConnection -LocalPort 20145 -State Listen -ErrorAction Stop)
    $ownerAfter=Get-CimInstance Win32_Process -Filter ("ProcessId="+$pidLocal)
    if($after.Count -ne 1 -or [int]$after[0].OwningProcess -ne $pidLocal -or
       [string]$after[0].LocalAddress -cne '127.0.0.1' -or
       $null -eq $ownerAfter -or
       [string]$ownerAfter.ExecutablePath -ine $exe -or
       [string]$ownerAfter.CreationDate -cne [string]$owner.CreationDate) {
        throw 'SERVER_PROCESS_CHANGED_DURING_AUDIT'
    }
    $binaryHash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $signature=Get-AuthenticodeSignature -LiteralPath $exe -ErrorAction Stop
    Mark 'ATTESTATION' 'PRELIMINARY_READONLY_OWNER_APPROVAL_PENDING'
    Mark 'MODEL_SHA256' 'PASS'
    Mark 'BINARY_SHA256' $binaryHash
    Mark 'AUTHENTICODE_STATUS' ([string]$signature.Status)
    Mark 'LOCAL_LISTEN' '127.0.0.1:20145_ONLY'
    Mark 'SERVER_PID_BOUND_TO_BINARY' 'PASS'
    Mark 'SERVER_COMMAND_LINE_MODEL_AND_LOCALHOST' 'PASS'
    Mark 'API_HEALTH_AND_MODEL_SELF_REPORT' 'PASS'
    Mark 'BINARY_PUBLISHER_TRUST' 'NOT_ESTABLISHED_BY_THIS_AUDIT'
    Mark 'CODEBRIDGE_AND_OMNIDESK' 'UNTOUCHED'
} catch {
    $reason=[string]$_.Exception.Message
    if($reason -notmatch '^[A-Z0-9_]{3,96}$') {$reason='ATTESTATION_PRECONDITION_FAILED'}
    Mark 'ATTESTATION' ('BLOCKED_'+$reason)
    Mark 'CODEBRIDGE_AND_OMNIDESK' 'UNTOUCHED'
    exit 2
}