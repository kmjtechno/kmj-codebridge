# Owner-only P520 Calibration Studio development profile admission.
# No private config is printed, no service is installed, no project file is overwritten.
[CmdletBinding()]
param([switch]$Apply,[switch]$EnableHardware,[switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$device='kmj-kmj-calibration-studio-desktop-5fvjmet'
$project='kmj-calibration-studio'
$studioOrigins=@('https://github.com/kmjtechno/KMJ-Calibration-Studio','https://github.com/kmjtechno/KMJ-Calibration-Studio.git','git@github.com:kmjtechno/KMJ-Calibration-Studio.git')
$runtimeOrigins=@('https://github.com/kmjtechno/kmj-codebridge','https://github.com/kmjtechno/kmj-codebridge.git','git@github.com:kmjtechno/kmj-codebridge.git')

function Require([bool]$Ok,[string]$Code) { if(!$Ok){throw $Code} }
function Ordinary([string]$Path,[bool]$Directory) {
    Require ([IO.Path]::IsPathRooted($Path)) 'STUDIO_PATH_NOT_ABSOLUTE'
    $item=Get-Item -LiteralPath $Path -Force
    Require ([bool]$item.PSIsContainer -eq $Directory) 'STUDIO_PATH_TYPE'
    $cursor=$item
    while($null -ne $cursor) {
        Require (!(($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint))) 'STUDIO_REPARSE_DENIED'
        if($cursor.PSIsContainer){$cursor=$cursor.Parent}else{$cursor=$cursor.Directory}
    }
}
function PrivateAcl([string]$Path) {
    $acl=Get-Acl -LiteralPath $Path
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Require ($acl.AreAccessRulesProtected) 'STUDIO_PRIVATE_ACL_INHERITED'
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    Require ($owner -in @($sid,'S-1-5-18','S-1-5-32-544')) 'STUDIO_PRIVATE_OWNER_INVALID'
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        Require ($rule.IdentityReference.Value -in @($sid,'S-1-5-18','S-1-5-32-544')) 'STUDIO_PRIVATE_ACL_WIDE'
    }
}
function GitScope([string]$Root,[string[]]$Origins) {
    Ordinary $Root $true
    $top=[string]((& git.exe -C $Root rev-parse --show-toplevel 2>$null)|Select-Object -First 1)
    Require ($LASTEXITCODE -eq 0 -and [IO.Path]::GetFullPath($top).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Root).TrimEnd('\')) 'STUDIO_GIT_ROOT_MISMATCH'
    $origin=[string]((& git.exe -C $Root remote get-url origin 2>$null)|Select-Object -First 1)
    Require ($LASTEXITCODE -eq 0 -and $origin.Trim() -cin $Origins) 'STUDIO_GIT_ORIGIN_DENIED'
}
function Variant([string[]]$ArgumentList,[int]$TimeoutMs) {
    return [ordered]@{args=@($ArgumentList);timeoutMs=$TimeoutMs}
}
function Profile([string]$Category,[string]$Description,[string]$Exe,$Variants) {
    return [ordered]@{category=$Category;description=$Description;command=$Exe;variants=$Variants}
}
function Profiles([string]$Root,[string]$Cmake,[string]$Ctest,[string]$Qt,[string]$Evidence,[bool]$Hardware) {
    $build=Join-Path $Root '.kmj-codebridge-studio-build'
    $qtbin=Join-Path $Qt 'bin'
    $envPath='PATH='+$qtbin+';'+$env:SystemRoot+'\System32;'+$env:SystemRoot
    $result=[ordered]@{}
    $result.studio_toolchain=Profile 'inspect' 'Inspect the selected CMake toolchain.' $Cmake ([ordered]@{version=(Variant @('--version') 10000)})
    $result.studio_configure=Profile 'build' 'Configure the current Studio checkout into a separate Qt build directory.' $Cmake ([ordered]@{qt=(Variant @('-S',$Root,'-B',$build,'-G','Visual Studio 18 2026','-A','x64',('-DCMAKE_PREFIX_PATH='+$Qt),'-DBUILD_TESTING=ON') 300000)})
    $result.studio_build=Profile 'build' 'Build the current Studio checkout; do not deploy or install.' $Cmake ([ordered]@{debug=(Variant @('--build',$build,'--config','Debug','--parallel','4') 300000);release=(Variant @('--build',$build,'--config','Release','--parallel','4') 300000)})
    $result.studio_test=Profile 'build' 'Run the existing offline CTest suite with failure output.' $Cmake ([ordered]@{
        debug=(Variant @('-E','env',$envPath,'--',$Ctest,'--test-dir',$build,'-C','Debug','--output-on-failure','--no-tests=error','-R','^(desktop-smoke|independent-engine|media-control)$') 300000)
        release=(Variant @('-E','env',$envPath,'--',$Ctest,'--test-dir',$build,'-C','Release','--output-on-failure','--no-tests=error','-R','^(desktop-smoke|independent-engine|media-control)$') 300000)
    })
    $result.studio_run=Profile 'build' 'Launch a bounded Studio development instance in a dedicated QA directory.' $Cmake ([ordered]@{
        debug=(Variant @('-E','chdir',$Evidence,$Cmake,'-E','env',$envPath,'--',(Join-Path $build 'Debug\KJApp.exe')) 300000)
        release=(Variant @('-E','chdir',$Evidence,$Cmake,'-E','env',$envPath,'--',(Join-Path $build 'Release\KJApp.exe')) 300000)
    })
    if($Hardware){
        # These existing project-owned native tests may open the camera and
        # display calibration patterns. Only admit with explicit local consent.
        # Evidence goes to a disposable QA directory, not the owner's live maps.
        $smoke=Join-Path $build 'Release\KJUiSmoke.exe'
        $result.studio_hardware=Profile 'build' 'Owner-consented camera preview or two-projector calibration smoke. Run only with the rig idle.' $Cmake ([ordered]@{
            camera=(Variant @('-E','chdir',$Evidence,$Cmake,'-E','env',$envPath,'--',$smoke,'--camera-readonly') 45000)
            scan=(Variant @('-E','chdir',$Evidence,$Cmake,'-E','env',$envPath,'--',$smoke,'--hardware-scan') 240000)
        })
    }
    return $result
}
function AddProfiles($Project,$Profiles) {
    if($Project.PSObject.Properties.Name -cnotcontains 'commands'){
        $Project|Add-Member -MemberType NoteProperty -Name commands -Value ([pscustomobject]@{})
    }
    $changed=$false
    foreach($name in $Profiles.Keys){
        $old=$Project.commands.PSObject.Properties[$name]
        if($null -ne $old){
            Require (($old.Value|ConvertTo-Json -Depth 16 -Compress) -ceq ($Profiles[$name]|ConvertTo-Json -Depth 16 -Compress)) 'STUDIO_PROFILE_CONFLICT'
        }else{
            $Project.commands|Add-Member -MemberType NoteProperty -Name $name -Value $Profiles[$name]
            $changed=$true
        }
    }
    return $changed
}

try {
    if($SelfTest){
        $p=[pscustomobject]@{id=$project;root='C:\fixture';writable=$true;label='preserve'}
        $profiles=Profiles 'C:\fixture' 'C:\cmake.exe' 'C:\ctest.exe' 'C:\Qt' 'C:\fixture\qa' $false
        Require ($profiles.Count -eq 5 -and !$profiles.Contains('studio_hardware')) 'STUDIO_SELFTEST_DEFAULT_SCOPE'
        Require (AddProfiles $p $profiles) 'STUDIO_SELFTEST_FIRST'
        Require (!(AddProfiles $p $profiles)) 'STUDIO_SELFTEST_IDEMPOTENCE'
        Require ($p.label -ceq 'preserve') 'STUDIO_SELFTEST_UNRELATED'
        $hardware=Profiles 'C:\fixture' 'C:\cmake.exe' 'C:\ctest.exe' 'C:\Qt' 'C:\fixture\qa' $true
        Require ($hardware.Count -eq 6 -and $hardware.Contains('studio_hardware')) 'STUDIO_SELFTEST_HARDWARE'
        foreach($name in @('camera','scan')){
            $argv=$hardware.studio_hardware.variants[$name].args
            Require ($argv[0] -ceq '-E' -and $argv[1] -ceq 'chdir' -and $argv[3] -ceq 'C:\cmake.exe' -and $argv[4] -ceq '-E' -and $argv[5] -ceq 'env') 'STUDIO_SELFTEST_NESTED_CMAKE'
        }
        Require ($profiles.studio_run.variants.debug.args[3] -ceq 'C:\cmake.exe') 'STUDIO_SELFTEST_RUN_NESTED_CMAKE'
        Require (AddProfiles $p $hardware) 'STUDIO_SELFTEST_HARDWARE_ADMISSION'
        $p.commands.studio_build.variants.debug.timeoutMs=11
        $denied=$false
        try{$null=AddProfiles $p (Profiles 'C:\fixture' 'C:\cmake.exe' 'C:\ctest.exe' 'C:\Qt' 'C:\fixture\qa' $true)}catch{$denied=$_.Exception.Message -ceq 'STUDIO_PROFILE_CONFLICT'}
        Require $denied 'STUDIO_SELFTEST_CONFLICT'
        Write-Output 'STUDIO_DEV_SELFTEST=PASS'
        exit 0
    }
    Require ($env:OS -ceq 'Windows_NT' -and $env:COMPUTERNAME -ieq 'DESKTOP-5FVJMET') 'STUDIO_WRONG_HOST'
    $base=Join-Path $env:LOCALAPPDATA ('KMJ-CodeBridge\private\devices\'+$device)
    $config=Join-Path $base 'agent.json'
    Ordinary $base $true
    Ordinary $config $false
    PrivateAcl $base
    PrivateAcl $config
    Require ((Get-Item -LiteralPath $config).Length -le 262144) 'STUDIO_CONFIG_TOO_LARGE'
    $original=[IO.File]::ReadAllBytes($config)
    $originalHash=(Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash
    $cfg=[Text.Encoding]::UTF8.GetString($original).TrimStart([char]0xFEFF)|ConvertFrom-Json
    Require ($cfg.id -ceq $device -and $cfg.gateway -cin @('https://kmjtechno.com','https://kmjtechno.com/')) 'STUDIO_DEVICE_SCOPE_MISMATCH'
    Require (@($cfg.projects).Count -eq 1 -and $cfg.projects[0].id -ceq $project -and $cfg.projects[0].writable -ceq $true) 'STUDIO_PROJECT_SCOPE_MISMATCH'
    $p=$cfg.projects[0]
    $root=[IO.Path]::GetFullPath([string]$p.root)
    GitScope $root $studioOrigins

    # The actual, already enrolled agent must identify exactly one active
    # Node/CLI process for this config. Never display process command lines.
    $agentProcesses=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($config,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -match '(?i)src[\\/]cli\.js"?\s+agent(?:\s|$)'
    })
    Require ($agentProcesses.Count -eq 1) 'STUDIO_AGENT_PROCESS_NOT_UNIQUE'
    $node=[string]$agentProcesses[0].ExecutablePath
    Ordinary $node $false
    $cliMatch=[regex]::Match([string]$agentProcesses[0].CommandLine,'(?i)(?:"(?<cli>[^"]+[\\/]src[\\/]cli\.js)"|(?<cli>[A-Z]:[\\/][^"\s]+[\\/]src[\\/]cli\.js))\s+agent(?:\s|$)')
    Require $cliMatch.Success 'STUDIO_RUNTIME_PATH_UNVERIFIED'
    $cli=[IO.Path]::GetFullPath($cliMatch.Groups['cli'].Value)
    Ordinary $cli $false
    $runtime=Split-Path -Parent (Split-Path -Parent $cli)
    GitScope $runtime $runtimeOrigins
    $dirty=@(& git.exe -C $runtime status --porcelain --untracked-files=no)
    Require ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'STUDIO_RUNTIME_TRACKED_DIRTY'
    Ordinary (Join-Path $runtime 'src\config.js') $false

    $cmake=(Get-Command cmake.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
    $ctest=(Get-Command ctest.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
    Ordinary $cmake $false
    Ordinary $ctest $false
    $qt='C:\Qt\6.12.0\msvc2022_64'
    Ordinary (Join-Path $qt 'bin\Qt6Core.dll') $false
    Ordinary (Join-Path $root 'CMakeLists.txt') $false
    $smoke=Join-Path $root 'tests\UiSmoke.cpp'
    Ordinary $smoke $false
    if($EnableHardware){
        $body=[IO.File]::ReadAllText($smoke)
        Require ($body.Contains('"--camera-readonly"') -and $body.Contains('"--hardware-scan"')) 'STUDIO_HARDWARE_ENTRYPOINT_MISSING'
        Require ([Environment]::UserInteractive) 'STUDIO_INTERACTIVE_SESSION_REQUIRED'
    }
    $build=Join-Path $root '.kmj-codebridge-studio-build'
    $evidence=Join-Path $root '.kmj-codebridge-studio-qa'
    $hadProfile=($p.PSObject.Properties.Name -ccontains 'commands') -and ($p.commands.PSObject.Properties.Name -ccontains 'studio_build')
    foreach($folder in @($build,$evidence)){
        if(Test-Path -LiteralPath $folder){
            Require $hadProfile 'STUDIO_PREEXISTING_OUTPUT_REVIEW'
            Ordinary $folder $true
        }
    }
    $wanted=Profiles $root $cmake $ctest $qt $evidence ([bool]$EnableHardware)
    $changed=AddProfiles $p $wanted
    Write-Output ('STUDIO_DEV_PROFILES='+$wanted.Count)
    Write-Output ('STUDIO_HARDWARE_OPTIN='+[int][bool]$EnableHardware)
    if(!$changed){
        Write-Output 'STUDIO_DEV=ALREADY_CONFIGURED_VERIFY_AGENT'
        exit 0
    }
    if(!$Apply){
        Write-Output 'STUDIO_DEV=READY_FOR_OWNER_APPLY'
        Write-Output 'PRIVATE_CONFIG_CHANGED=NO'
        exit 0
    }
    $nonce=[guid]::NewGuid().ToString('N')
    $tmp=Join-Path $base ('agent.studio-stage-'+$nonce+'.json')
    $backup=Join-Path $base ('agent.studio-backup-'+$nonce+'.json')
    try {
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($cfg|ConvertTo-Json -Depth 32))
        Require ($bytes.Length -le 262144) 'STUDIO_CONFIG_TOO_LARGE'
        $stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        & "$env:SystemRoot\System32\icacls.exe" $tmp '/inheritance:r' '/grant:r' ('*'+$sid+':F') 1>$null 2>$null
        Require ($LASTEXITCODE -eq 0) 'STUDIO_STAGE_ACL_FAILED'
        PrivateAcl $tmp
        $js='import fs from "node:fs"; import {agentSchema} from "./src/config.js"; try {agentSchema.parse(JSON.parse(fs.readFileSync(process.argv[1],"utf8")));process.stdout.write("SCHEMA_PASS");}catch{process.exit(2);}'
        Push-Location -LiteralPath $runtime
        try{$valid=[string](& $node --input-type=module -e $js $tmp 2>$null);$rc=$LASTEXITCODE}finally{Pop-Location}
        Require ($rc -eq 0 -and $valid -ceq 'SCHEMA_PASS') 'STUDIO_CONFIG_SCHEMA_REJECTED'
        Require ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ceq $originalHash) 'STUDIO_CONFIG_MOVED'
        if(!(Test-Path -LiteralPath $evidence)){
            New-Item -ItemType Directory -Path $evidence|Out-Null
        }
        Ordinary $evidence $true
        [IO.File]::Replace($tmp,$config,$backup)
        PrivateAcl $config
        PrivateAcl $backup
        $check=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json
        Require ($check.id -ceq $device -and @($check.projects).Count -eq 1 -and $check.projects[0].id -ceq $project) 'STUDIO_CONFIG_POSTWRITE_SCOPE'
        foreach($name in $wanted.Keys){
            Require ($check.projects[0].commands.PSObject.Properties.Name -ccontains $name) 'STUDIO_CONFIG_POSTWRITE_PROFILE'
        }
        Write-Output 'STUDIO_DEV=CONFIG_APPLIED_RESTART_REQUIRED'
        Write-Output 'AGENT_RESTARTED=NO'
        Write-Output 'PROJECT_SOURCE_CHANGED=NO'
        Write-Output 'PRIVATE_BACKUP=OWNER_ONLY'
        Write-Output 'SECRET_OUTPUT=NONE'
    }finally{
        if(Test-Path -LiteralPath $tmp -PathType Leaf){Remove-Item -LiteralPath $tmp -Force}
    }
}catch{
    if($SelfTest){
        # Fixture-only diagnostics; never expose real owner-config exceptions.
        Write-Output ('STUDIO_SELFTEST_ERROR_LINE='+$_.InvocationInfo.ScriptLineNumber)
        Write-Output ('STUDIO_SELFTEST_ERROR_TYPE='+$_.Exception.GetType().Name)
        Write-Output ('STUDIO_SELFTEST_ERROR='+[string]$_.Exception.Message)
    }
    $code=[string]$_.Exception.Message
    if($code -notmatch '^STUDIO_[A-Z0-9_]{3,100}$'){$code='STUDIO_LOCAL_PRECONDITION_FAILED'}
    Write-Output ('STUDIO_DEV=BLOCKED:'+$code)
    Write-Output 'SECRET_OUTPUT=NONE'
    exit 2
}
