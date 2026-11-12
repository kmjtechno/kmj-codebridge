# KMJ TECHNO — owner-run, fail-closed CodeBridge Studio QA preset opt-in.
# Default is read-only. -Apply changes ONLY one approved current-user project
# profile after local schema validation. Never prints or exports credentials.
[CmdletBinding()]
param([switch]$Apply,[switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$projectId='kmj-calibration-studio'
$preset='calibration-studio-qt-offline'
$requiredCommit='91718429e3c4f72b64df066a1d749c83140d2650'
$approvedCodeBridgeOrigin=@(
    'https://github.com/kmjtechno/kmj-codebridge',
    'https://github.com/kmjtechno/kmj-codebridge.git',
    'git@github.com:kmjtechno/kmj-codebridge.git'
)
$approvedStudioOrigin=@(
    'https://github.com/kmjtechno/KMJ-Calibration-Studio',
    'https://github.com/kmjtechno/KMJ-Calibration-Studio.git',
    'git@github.com:kmjtechno/KMJ-Calibration-Studio.git'
)

function Fail([string]$Reason) { throw $Reason }

function Ordinary([string]$Path,[bool]$Directory) {
    if (![IO.Path]::IsPathRooted($Path)) { Fail 'QA_PATH_NOT_ABSOLUTE' }
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne $Directory) { Fail 'QA_PATH_TYPE_MISMATCH' }
    $cursor=if($Directory){$item}else{$item.Directory}
    while($null -ne $cursor) {
        if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail 'QA_REPARSE_POINT_REFUSED'
        }
        $cursor=$cursor.Parent
    }
    if (!$Directory -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Fail 'QA_REPARSE_POINT_REFUSED'
    }
}

function AddOnlyStudioPreset($Cfg) {
    $projects=@($Cfg.projects)
    if ($projects.Count -ne 1 -or [string]$projects[0].id -cne $projectId -or
        $projects[0].writable -cne $true) {
        Fail 'QA_UNEXPECTED_PROJECT_SCOPE'
    }
    $project=$projects[0]
    $old=@()
    if ($project.PSObject.Properties.Name -contains 'commandPresets') {
        $old=@($project.commandPresets)
    }
    if ($old.Count -gt 20) { Fail 'QA_PRESET_COUNT_UNSAFE' }
    $seen=@{}
    foreach($entry in $old) {
        $label=[string]$entry
        if($label -notmatch '^[a-z0-9-]{3,64}$' -or $seen.ContainsKey($label)) {
            Fail 'QA_EXISTING_PRESETS_INVALID'
        }
        $seen[$label]=$true
    }
    if($seen.ContainsKey($preset)) { return $false }
    $new=@($old)+@($preset)
    if($project.PSObject.Properties.Name -contains 'commandPresets') {
        $project.commandPresets=$new
    }else{
        $project | Add-Member -MemberType NoteProperty -Name commandPresets -Value $new
    }
    return $true
}

function CheckScope($Cfg,[string]$ExpectedDevice) {
    if ($null -eq $Cfg -or
        [string]$Cfg.id -cne $ExpectedDevice -or
        [string]$Cfg.tenant -notmatch '^[A-Za-z0-9_-]{1,64}$' -or
        [string]$Cfg.gateway -cnotin @('https://kmjtechno.com','https://kmjtechno.com/') -or
        $null -eq $Cfg.projects) { Fail 'QA_PRIVATE_DEVICE_SCOPE_MISMATCH' }
    $hasToken=($Cfg.PSObject.Properties.Name -contains 'token') -and
        ![string]::IsNullOrWhiteSpace([string]$Cfg.token)
    $hasTokenFile=($Cfg.PSObject.Properties.Name -contains 'gatewayTokenFile')
    if ($hasToken -eq $hasTokenFile) { Fail 'QA_PRIVATE_CREDENTIAL_MODE_INVALID' }
    if ($hasToken -and ([string]$Cfg.token).Length -lt 32) {
        Fail 'QA_PRIVATE_CREDENTIAL_LENGTH_INVALID'
    }
    $project=@($Cfg.projects)
    if ($project.Count -ne 1 -or [string]$project[0].id -cne $projectId) {
        Fail 'QA_NOT_CALIBRATION_STUDIO_PROJECT'
    }
    if (![IO.Path]::IsPathRooted([string]$project[0].root)) {
        Fail 'QA_STUDIO_GIT_ROOT_INVALID'
    }
    Ordinary ([string]$project[0].root) $true
    $top=[string]((& git.exe -C ([string]$project[0].root) rev-parse --show-toplevel 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($top) -ine
        [IO.Path]::GetFullPath([string]$project[0].root)) { Fail 'QA_STUDIO_GIT_ROOT_MISMATCH' }
    $origin=[string]((& git.exe -C ([string]$project[0].root) remote get-url origin 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $origin.Trim() -cnotin $approvedStudioOrigin) {
        Fail 'QA_STUDIO_ORIGIN_NOT_APPROVED'
    }
}

function PrivateAcl([string]$Path) {
    $acl=Get-Acl -LiteralPath $Path
    if (!$acl.AreAccessRulesProtected) { Fail 'QA_PRIVATE_ACL_INHERITANCE_NOT_BLOCKED' }
}

try {
    if ($env:OS -cne 'Windows_NT') { Fail 'QA_WINDOWS_REQUIRED' }
    if($SelfTest) {
        $fixture=[pscustomobject]@{
            id='fixture';projects=@([pscustomobject]@{
                id=$projectId;root='C:\fixture';writable=$true;label='KEEP'
            })
        }
        if (!(AddOnlyStudioPreset $fixture)) { Fail 'QA_SELFTEST_FIRST_OPTIN_FAILED' }
        if ((AddOnlyStudioPreset $fixture)) { Fail 'QA_SELFTEST_IDEMPOTENCE_FAILED' }
        if ([string]$fixture.projects[0].label -cne 'KEEP' -or
            @($fixture.projects[0].commandPresets).Count -ne 1) {
            Fail 'QA_SELFTEST_UNRELATED_FIELD_CHANGED'
        }
        $fixture.projects[0].id='another-project'
        $blocked=$false
        try{$null=AddOnlyStudioPreset $fixture}catch{
            if($_.Exception.Message -ne 'QA_UNEXPECTED_PROJECT_SCOPE'){throw}
            $blocked=$true
        }
        if(!$blocked){Fail 'QA_SELFTEST_FOREIGN_PROJECT_ALLOWED'}
        Write-Output 'KJ_CODEBRIDGE_QA_OPTIN_SELFTEST=PASS'
        Write-Output 'OWNER_FILES=UNTOUCHED'
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        Fail 'QA_LOCAL_APPDATA_UNAVAILABLE'
    }
    $repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    Ordinary $repo $true
    Ordinary $PSCommandPath $false
    $remote=[string]((& git.exe -C $repo remote get-url origin 2>$null) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $remote.Trim() -cnotin $approvedCodeBridgeOrigin) {
        Fail 'QA_RUNTIME_ORIGIN_NOT_APPROVED'
    }
    $top=[string]((& git.exe -C $repo rev-parse --show-toplevel 2>$null) | Select-Object -First 1)
    if($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($top) -ine $repo) {
        Fail 'QA_RUNTIME_GIT_ROOT_MISMATCH'
    }
    $null=& git.exe -C $repo merge-base --is-ancestor $requiredCommit HEAD 2>$null
    if($LASTEXITCODE -ne 0){Fail 'QA_CODEBRIDGE_PRESET_NOT_IN_CURRENT_SOURCE'}
    $dirty=@(& git.exe -C $repo status --porcelain --untracked-files=no)
    if($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0){Fail 'QA_CODEBRIDGE_RUNTIME_DIRTY'}
    $tracked=@(& git.exe -C $repo ls-files --error-unmatch -- 'scripts/windows/ENABLE-CALIBRATION-STUDIO-QA.ps1' 2>$null)
    if($LASTEXITCODE -ne 0 -or $tracked.Count -ne 1){Fail 'QA_OPTIN_SCRIPT_NOT_GIT_TRACKED'}
    $hostSlug=([string]$env:COMPUTERNAME -replace '[^A-Za-z0-9_-]','-').ToLowerInvariant()
    if ($hostSlug -notmatch '^[a-z0-9_-]{3,40}$') { Fail 'QA_HOST_SCOPE_INVALID' }
    $device='kmj-kmj-calibration-studio-' + $hostSlug
    $base=Join-Path $env:LOCALAPPDATA ('KMJ-CodeBridge\private\devices\' + $device)
    $config=Join-Path $base 'agent.json'
    Ordinary $base $true
    Ordinary $config $false
    PrivateAcl $base
    PrivateAcl $config
    if((Get-Item -LiteralPath $config).Length -gt 262144){Fail 'QA_CONFIG_TOO_LARGE'}
    $cfg=Get-Content -LiteralPath $config -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    CheckScope $cfg $device
    $changed=AddOnlyStudioPreset $cfg
    if(!$changed) {
        Write-Output 'KJ_CODEBRIDGE_QA_OPTIN=ALREADY_CONFIGURED'
        Write-Output 'PRIVATE_TOKENS_PRINTED=NO'
        exit 0
    }
    if(!$Apply) {
        Write-Output 'KJ_CODEBRIDGE_QA_OPTIN=READY_FOR_OWNER_APPLY'
        Write-Output 'CHANGES=ONE_PROJECT_PRESET_ONLY'
        Write-Output 'OWNER_FILES=UNTOUCHED'
        Write-Output 'PRIVATE_TOKENS_PRINTED=NO'
        exit 0
    }
    $nonce=[guid]::NewGuid().ToString('N')
    $tmp=Join-Path $base ('agent.qa-stage-' + $nonce + '.json')
    $backup=Join-Path $base ('agent.qa-backup-' + $nonce + '.json')
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($cfg | ConvertTo-Json -Depth 32))
    if($bytes.Length -gt 262144){Fail 'QA_NEW_CONFIG_TOO_LARGE'}
    $stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}
    finally{$stream.Dispose()}
    try {
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $icacls=Join-Path $env:SystemRoot 'System32\icacls.exe'
        Ordinary $icacls $false
        & $icacls $tmp '/inheritance:r' '/grant:r' ('*'+$sid+':F') 1>$null 2>$null
        if($LASTEXITCODE -ne 0){Fail 'QA_STAGE_PRIVATE_ACL_FAILED'}
        PrivateAcl $tmp
        $node=(Get-Command node.exe -ErrorAction Stop).Source
        Ordinary $node $false
        # Full CodeBridge schema validation before any protected config write.
        $js='import fs from "node:fs"; import {agentSchema} from "./src/config.js"; try { agentSchema.parse(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))); process.stdout.write("SCHEMA_PASS"); } catch { process.exit(2); }'
        Push-Location -LiteralPath $repo
        try {
            $valid=[string](& $node --input-type=module -e $js $tmp 2>$null)
            $nodeExit=$LASTEXITCODE
        }finally{
            Pop-Location
        }
        if($nodeExit -ne 0 -or $valid -cne 'SCHEMA_PASS'){
            Fail 'QA_STAGED_CODEBRIDGE_SCHEMA_REJECTED'
        }
        [IO.File]::Replace($tmp,$config,$backup)
        Ordinary $config $false
        Ordinary $backup $false
        PrivateAcl $config
        PrivateAcl $backup
        $check=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json -ErrorAction Stop
        if([string]$check.id -cne $device -or
            @($check.projects).Count -ne 1 -or
            @($check.projects[0].commandPresets) -cnotcontains $preset){
            Fail 'QA_CONFIG_POSTWRITE_MISMATCH'
        }
        Write-Output 'KJ_CODEBRIDGE_QA_OPTIN=CONFIG_APPLIED_RESTART_REQUIRED'
        Write-Output 'KJ_CODEBRIDGE_QA_PROFILE=CALIBRATION_STUDIO_ONLY'
        Write-Output 'AGENT_PROCESS_RESTARTED=NO'
        Write-Output 'PRIVATE_BACKUP=OWNER_ONLY'
        Write-Output 'PRIVATE_TOKENS_PRINTED=NO'
    }finally{
        if(Test-Path -LiteralPath $tmp -PathType Leaf){
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}catch{
    $reason=[string]$_.Exception.Message
    if($reason -notmatch '^[A-Z][A-Z0-9_]{3,110}$'){
        $reason='QA_OWNER_SCOPE_OR_CONFIG_VALIDATION_FAILED'
    }
    Write-Output ('KJ_CODEBRIDGE_QA_OPTIN=BLOCKED:'+$reason)
    Write-Output 'PRIVATE_TOKENS_PRINTED=NO'
    exit 2
}
