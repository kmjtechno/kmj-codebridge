# Owner-only P520 Calibration Studio development profile admission.
# No private config is printed, no service is installed, no project file is overwritten.
[CmdletBinding()]
param([switch]$Apply,[switch]$EnableHardware,[switch]$EnablePython,[switch]$EnableSupervisor,[switch]$EnablePackaging,[switch]$SelfTest,[switch]$SchemaSelfTest)
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
    Require ((($Directory -and $item -is [IO.DirectoryInfo]) -or (!$Directory -and $item -is [IO.FileInfo]))) 'STUDIO_PATH_TYPE'
    $cursor=$item
    while($null -ne $cursor) {
        Require (!(($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint))) 'STUDIO_REPARSE_DENIED'
        if($cursor -is [IO.DirectoryInfo]){$cursor=$cursor.Parent}
        elseif($cursor -is [IO.FileInfo]){$cursor=$cursor.Directory}
        else{throw 'STUDIO_PATH_TYPE'}
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
# PowerShell 5.1's native -e quoting loses embedded JavaScript quotes.
# Send fixed source via stdin, use an ordinary file argument, and never surface
# child stderr (which may contain private paths or schema values).
function InvokeNodeInput([string]$Node,[string]$Runtime,[string]$InputFile,[string]$Source) {
    Ordinary $Node $false
    Ordinary $Runtime $true
    Ordinary $InputFile $false
    Require (!$InputFile.Contains('"')) 'STUDIO_SCHEMA_PATH_UNSAFE'
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=$Node
    $start.WorkingDirectory=$Runtime
    $start.Arguments='--input-type=module - "'+$InputFile+'"'
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true
    $start.RedirectStandardOutput=$true
    $start.RedirectStandardError=$true
    # Do not inherit Node injection/debug settings from the owner environment.
    foreach($name in @('NODE_OPTIONS','NODE_PATH','NODE_DEBUG','NODE_DEBUG_NATIVE')){
        $start.EnvironmentVariables.Remove($name)
    }
    $child=New-Object Diagnostics.Process
    $child.StartInfo=$start
    try {
        Require ($child.Start()) 'STUDIO_SCHEMA_PROCESS_START_FAILED'
        $outputTask=$child.StandardOutput.ReadToEndAsync()
        $errorTask=$child.StandardError.ReadToEndAsync()
        $child.StandardInput.Write($Source)
        $child.StandardInput.Close()
        if(!$child.WaitForExit(15000)){
            $child.Kill()
            $null=$child.WaitForExit(3000)
            throw 'STUDIO_SCHEMA_PROCESS_TIMEOUT'
        }
        Require ($outputTask.Wait(2000) -and $errorTask.Wait(2000)) 'STUDIO_SCHEMA_PIPE_TIMEOUT'
        # Only known fixed status codes are ever printed by the caller.
        $out=$outputTask.Result
        Require ($out.Length -le 64) 'STUDIO_SCHEMA_OUTPUT_INVALID'
        return [pscustomobject]@{ExitCode=$child.ExitCode;Marker=$out}
    }finally{$child.Dispose()}
}
function ValidateStagedConfig([string]$Node,[string]$Runtime,[string]$InputFile) {
    $source='import fs from "node:fs"; let schema; try { ({agentSchema:schema}=await import("./src/config.js")); } catch {process.stdout.write("SCHEMA_IMPORT_FAILED");process.exit(3);} try {schema.parse(JSON.parse(fs.readFileSync(process.argv[2],"utf8")));process.stdout.write("SCHEMA_PASS");} catch {process.stdout.write("SCHEMA_REJECTED");process.exit(2);}'
    $result=InvokeNodeInput $Node $Runtime $InputFile $source
    if($result.ExitCode -eq 3 -and $result.Marker -ceq 'SCHEMA_IMPORT_FAILED'){throw 'STUDIO_RUNTIME_SCHEMA_IMPORT_FAILED'}
    if($result.ExitCode -eq 2 -and $result.Marker -ceq 'SCHEMA_REJECTED'){throw 'STUDIO_CONFIG_SCHEMA_REJECTED'}
    Require ($result.ExitCode -eq 0 -and $result.Marker -ceq 'SCHEMA_PASS') 'STUDIO_SCHEMA_PROCESS_FAILED'
}
# Owner-scoped native supervisor: no elevated service, restart task or other
# project authority. The existing interactive launcher remains the agent owner.
$studioPipeName='kmj-codebridge-supervisor-p520-studio'
function StudioSupervisorConfig([string]$Runtime,[string]$Root,[string]$Config,[string]$Token) {
    return [ordered]@{
        pipeName=$studioPipeName
        tokenFile=$Token
        agent=@{installDir=$Runtime;configPath=$Config}
        projects=@()
        rustProjects=@()
        readOnlyProjects=@(@{id=$project;repoRoot=$Root})
    }
}
function WritePrivateNew([string]$File,[string]$Content) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Content)
    $stream=[IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & "$env:SystemRoot\System32\icacls.exe" $File '/inheritance:r' '/grant:r' ('*'+$sid+':F') 1>$null 2>$null
    Require ($LASTEXITCODE -eq 0) 'STUDIO_PRIVATE_FILE_ACL_FAILED'
    PrivateAcl $File
}
function ValidateSupervisorFile([string]$Node,[string]$Runtime,[string]$File) {
    $source='import fs from "node:fs";import {createWindowsSupervisorConfigSchema} from "./src/windows-supervisor.js";try{createWindowsSupervisorConfigSchema().parse(JSON.parse(fs.readFileSync(process.argv[2],"utf8")));process.stdout.write("SUPERVISOR_SCHEMA_PASS")}catch{process.exit(2)}'
    $result=InvokeNodeInput $Node $Runtime $File $source
    Require ($result.ExitCode -eq 0 -and $result.Marker -ceq 'SUPERVISOR_SCHEMA_PASS') 'STUDIO_SUPERVISOR_SCHEMA_REJECTED'
}
function ProbeStudioSupervisor([string]$Node,[string]$Runtime,[string]$File) {
    $source='import fs from "node:fs";import {windowsSupervisorRequest} from "./src/supervisor-client.js";const c=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));try{const o=await windowsSupervisorRequest({pipePath:"\\\\.\\pipe\\"+c.pipeName,tokenFile:c.tokenFile},{op:"status",service:"agent"},{timeoutMs:1500});if(o.supervisor==="windows-native"&&o.service==="agent"&&o.restart.supported===false){process.stdout.write("SUPERVISOR_HMAC_PASS")}else{process.exit(3)}}catch{process.exit(2)}'
    $result=InvokeNodeInput $Node $Runtime $File $source
    return ($result.ExitCode -eq 0 -and $result.Marker -ceq 'SUPERVISOR_HMAC_PASS')
}
function InstallStudioSupervisor([string]$Node,[string]$Cli,[string]$Runtime,[string]$Root,[string]$Config,[string]$SupFile,[string]$Token,[string]$Shortcut) {
    foreach($file in @($SupFile,$Token,$Shortcut)){Require (!(Test-Path -LiteralPath $file)) 'STUDIO_SUPERVISOR_EXISTING_REVIEW'}
    $createdToken=$false
    $createdConfig=$false
    $createdShortcut=$false
    $child=$null
    $success=$false
    try{
        # Parent directory was already validated private; token is random and
        # written once with a protected owner-only ACL. Never reuse a secret.
        $random=New-Object byte[] 32
        $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
        try{$rng.GetBytes($random)}finally{$rng.Dispose()}
        $secret=[BitConverter]::ToString($random).Replace('-','').ToLowerInvariant()
        # Mark ownership only after a successful exclusive create.
        WritePrivateNew $Token $secret
        $createdToken=$true
        $secret=$null
        $supervisor=StudioSupervisorConfig $Runtime $Root $Config $Token
        WritePrivateNew $SupFile ($supervisor|ConvertTo-Json -Depth 8)
        $createdConfig=$true
        ValidateSupervisorFile $Node $Runtime $SupFile
        $argv='"'+$Cli+'" windows-supervisor "'+$SupFile+'"'
        $child=Start-Process -FilePath $Node -ArgumentList $argv -WorkingDirectory $Runtime -WindowStyle Hidden -PassThru
        $verified=$false
        for($i=0;$i -lt 5;$i++){
            Start-Sleep -Milliseconds 500
            $child.Refresh()
            Require (!$child.HasExited) 'STUDIO_SUPERVISOR_EXITED'
            if(ProbeStudioSupervisor $Node $Runtime $SupFile){$verified=$true;break}
        }
        Require $verified 'STUDIO_SUPERVISOR_HMAC_FAILED'
        $child.Refresh()
        Require (!$child.HasExited) 'STUDIO_SUPERVISOR_EXITED'
        Require (!(Test-Path -LiteralPath $Shortcut)) 'STUDIO_SUPERVISOR_SHORTCUT_COLLISION'
        $shell=New-Object -ComObject WScript.Shell
        $link=$shell.CreateShortcut($Shortcut)
        $link.TargetPath=$Node
        $link.Arguments=$argv
        $link.WorkingDirectory=$Runtime
        $link.WindowStyle=7
        $link.Description='KMJ Studio project-only native supervisor'
        $link.Save()
        $createdShortcut=$true
        Ordinary $Shortcut $false
        $confirm=$shell.CreateShortcut($Shortcut)
        Require ($confirm.TargetPath -ieq $Node -and $confirm.Arguments -ceq $argv -and $confirm.WorkingDirectory -ieq $Runtime) 'STUDIO_SUPERVISOR_SHORTCUT_VERIFY_FAILED'
        $success=$true
        Write-Output 'STUDIO_SUPERVISOR_HMAC=PASS'
        Write-Output 'STUDIO_SUPERVISOR_STARTUP=OWNER_SHORTCUT'
    }finally{
        if(!$success){
            if($null -ne $child){
                $child.Refresh()
                if(!$child.HasExited){$child.Kill();$null=$child.WaitForExit(3000)}
            }
            # Only exact files created by this attempt; never touch prior files.
            if($createdShortcut){Remove-Item -LiteralPath $Shortcut -ErrorAction SilentlyContinue}
            if($createdConfig){Remove-Item -LiteralPath $SupFile -ErrorAction SilentlyContinue}
            if($createdToken){Remove-Item -LiteralPath $Token -ErrorAction SilentlyContinue}
        }
        if($null -ne $child){$child.Dispose()}
    }
}
function ExtraStudioProfiles([string]$Root,[string]$Python,[string]$Git) {
    $extra=[ordered]@{}
    $extra.studio_git_read=Profile 'inspect' 'Inspect the current project Git HEAD and status without changing the index or source.' $Git ([ordered]@{
        head=(Variant @('--no-optional-locks','-C',$Root,'rev-parse','HEAD') 10000)
        status=(Variant @('--no-optional-locks','-C',$Root,'status','--short','--untracked-files=normal') 15000)
    })
    if($Python){
        $extra.studio_python=Profile 'build' 'Run selected offline Python calibration regressions; no dependency installation or hardware access requested.' $Python ([ordered]@{
            version=(Variant @('--version') 10000)
            regression=(Variant @('-B','-m','pytest','-p','no:cacheprovider','-q','tests/test_fisheye_calibration.py','tests/test_calibration_map_integrity.py','tests/test_relative_surface.py','tests/test_projector_coverage.py') 300000)
        })
    }
    return $extra
}
# Reserved calibration_studio_qt_qa ID already enforces a detached exact HEAD
# on older agents; the bundled first-party script executes all three phases
# in one job because subsequent jobs refuse a dirty generated worktree.
function ExactStudioProfiles([string]$Node,[string]$Runtime,[string]$State,[string]$Cmake,[string]$Ctest,[string]$Qt,[bool]$Hardware) {
    $extra=[ordered]@{}
    $helper=Join-Path $Runtime 'scripts\studio-exact-head-qa.mjs'
    $extra.calibration_studio_qt_qa=Profile 'build' 'Build and run required offline Qt CTests in an exact-head private lane only; no hardware or release.' $Node ([ordered]@{
        full=(Variant @($helper,$State,$Cmake,$Ctest,$Qt) 300000)
    })
    if($Hardware){
        $extra.studio_hardware_evidence=Profile 'inspect' 'Hash existing local camera QA evidence; no new camera or projector activation.' $Cmake ([ordered]@{
            camera=(Variant @('-E','sha256sum','.kmj-codebridge-studio-qa/artifacts/camera-probe.txt','.kmj-codebridge-studio-qa/artifacts/camera-readonly-result.json','.kmj-codebridge-studio-qa/artifacts/standalone-camera-live.png') 15000)
        })
    }
    return $extra
}
function StudioPackageProfile([string]$Node,[string]$Runtime,[string]$State,[string]$Git,[string]$PowerShell,[string]$Qt) {
    return (Profile 'build' 'Run exact-head locked acceptance and build an isolated Windows ZIP candidate; never install, sign or publish.' $Node ([ordered]@{
        candidate=(Variant @((Join-Path $Runtime 'scripts\studio-locked-package.mjs'),$State,$Git,$PowerShell,$Qt) 300000)
    }))
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
    Require (!$SchemaSelfTest -or $SelfTest) 'STUDIO_SCHEMA_SELFTEST_SCOPE'
    if($SelfTest){
        # Exercise actual filesystem ancestor traversal, not just profile data.
        $fixture=Join-Path ([IO.Path]::GetTempPath()) ('kmj-studio-path-'+[guid]::NewGuid().ToString('N'))
        try {
            $nested=Join-Path $fixture 'nested'
            [void][IO.Directory]::CreateDirectory($nested)
            $leaf=Join-Path $nested 'fixture.txt'
            [IO.File]::WriteAllText($leaf,'fixture')
            Ordinary $nested $true
            Ordinary $leaf $false
            $wrongTypeDenied=$false
            try{Ordinary $leaf $true}catch{$wrongTypeDenied=$_.Exception.Message -ceq 'STUDIO_PATH_TYPE'}
            Require $wrongTypeDenied 'STUDIO_SELFTEST_PATH_TYPE'
            Write-Output 'STUDIO_PATH_TRAVERSAL_SELFTEST=PASS'
        }finally{
            if([IO.Directory]::Exists($fixture)){[IO.Directory]::Delete($fixture,$true)}
        }
        $nodeFixture=(Get-Command node.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
        $transportFixture=Join-Path ([IO.Path]::GetTempPath()) ('kmj studio schema '+[guid]::NewGuid().ToString('N'))
        try {
            [void][IO.Directory]::CreateDirectory($transportFixture)
            $json=Join-Path $transportFixture 'fixture config.json'
            [IO.File]::WriteAllText($json,'{"fixture":"quoted value"}',[Text.UTF8Encoding]::new($false))
            $transport='import fs from "node:fs";const data=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(data.fixture!=="quoted value")process.exit(4);process.stdout.write("TRANSPORT_PASS");'
            $result=InvokeNodeInput $nodeFixture $transportFixture $json $transport
            Require ($result.ExitCode -eq 0 -and $result.Marker -ceq 'TRANSPORT_PASS') 'STUDIO_SELFTEST_NODE_TRANSPORT'
            $negative=InvokeNodeInput $nodeFixture $transportFixture $json 'process.stderr.write("FIXTURE_PRIVATE_STDERR");process.stdout.write("REJECTED");process.exit(2);'
            Require ($negative.ExitCode -eq 2 -and $negative.Marker -ceq 'REJECTED') 'STUDIO_SELFTEST_NODE_NEGATIVE'
            Write-Output 'STUDIO_NODE_TRANSPORT_SELFTEST=PASS'
            if($SchemaSelfTest){
                $runtimeFixture=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
                $synthetic=[ordered]@{id=$device;tenant='fixture';gateway='https://kmjtechno.com';token=('x'*32);stateDir=$transportFixture;license=@{mode='free'};projects=@(@{id=$project;root=$transportFixture;writable=$true;commands=(Profiles $transportFixture 'C:\cmake.exe' 'C:\ctest.exe' 'C:\Qt' $transportFixture $true)})}
                [IO.File]::WriteAllText($json,($synthetic|ConvertTo-Json -Depth 32),[Text.UTF8Encoding]::new($false))
                ValidateStagedConfig $nodeFixture $runtimeFixture $json
                $extra=ExtraStudioProfiles $transportFixture 'C:\Python\python.exe' 'C:\Git\git.exe'
                foreach($name in $extra.Keys){$synthetic.projects[0].commands[$name]=$extra[$name]}
                $exact=ExactStudioProfiles $nodeFixture $runtimeFixture $transportFixture 'C:\cmake.exe' 'C:\ctest.exe' 'C:\Qt' $true
                Require ($exact.Count -eq 2 -and $exact.calibration_studio_qt_qa.variants.full.args[0] -ieq (Join-Path $runtimeFixture 'scripts\studio-exact-head-qa.mjs')) 'STUDIO_EXACT_PROFILE_SCOPE'
                foreach($name in $exact.Keys){$synthetic.projects[0].commands[$name]=$exact[$name]}
                $package=StudioPackageProfile $nodeFixture $runtimeFixture $transportFixture 'C:\git.exe' 'C:\powershell.exe' 'C:\Qt'
                Require ($package.variants.candidate.args[0] -ieq (Join-Path $runtimeFixture 'scripts\studio-locked-package.mjs')) 'STUDIO_PACKAGE_PROFILE_SCOPE'
                $synthetic.projects[0].commands.calibration_studio_package=$package
                Write-Output 'STUDIO_PACKAGE_PROFILE_SELFTEST=PASS'
                Write-Output 'STUDIO_EXACT_PROFILE_SELFTEST=PASS'
                $supervisorFixture=StudioSupervisorConfig $runtimeFixture $transportFixture $json (Join-Path $transportFixture 'fixture.token')
                $supervisorFile=Join-Path $transportFixture 'supervisor fixture.json'
                [IO.File]::WriteAllText($supervisorFile,($supervisorFixture|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
                ValidateSupervisorFile $nodeFixture $runtimeFixture $supervisorFile
                $synthetic.supervisorPipe='\\.\pipe\'+$studioPipeName
                $synthetic.supervisorTokenFile=$supervisorFixture.tokenFile
                [IO.File]::WriteAllText($json,($synthetic|ConvertTo-Json -Depth 32),[Text.UTF8Encoding]::new($false))
                ValidateStagedConfig $nodeFixture $runtimeFixture $json
                Require ($supervisorFixture.projects.Count -eq 0 -and $supervisorFixture.readOnlyProjects.Count -eq 1 -and !$supervisorFixture.agent.ContainsKey('restartTask')) 'STUDIO_SELFTEST_SUPERVISOR_SCOPE'
                Write-Output 'STUDIO_SUPERVISOR_SCHEMA_SELFTEST=PASS'
                $synthetic.projects[0].commands.studio_build.variants.debug.timeoutMs=300001
                [IO.File]::WriteAllText($json,($synthetic|ConvertTo-Json -Depth 32),[Text.UTF8Encoding]::new($false))
                $schemaDenied=$false
                try{ValidateStagedConfig $nodeFixture $runtimeFixture $json}catch{$schemaDenied=$_.Exception.Message -ceq 'STUDIO_CONFIG_SCHEMA_REJECTED'}
                Require $schemaDenied 'STUDIO_SELFTEST_SCHEMA_NEGATIVE'
                Write-Output 'STUDIO_REAL_SCHEMA_SELFTEST=PASS'
            }
        }finally{
            if([IO.Directory]::Exists($transportFixture)){[IO.Directory]::Delete($transportFixture,$true)}
        }
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
    Require ($root -ieq 'D:\KMJ Calibration Studio') 'STUDIO_ROOT_MISMATCH'
    GitScope $root $studioOrigins

    # The actual, already enrolled agent must identify exactly one active
    # Node/CLI process for this config. Never display process command lines.
    $agentProcesses=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($config,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -match '(?i)src[\\/]cli\.js"?\s+agent(?:\s|$)'
    })
    Require ($agentProcesses.Count -eq 1) 'STUDIO_AGENT_PROCESS_NOT_UNIQUE'
    $ownerResult=Invoke-CimMethod -InputObject $agentProcesses[0] -MethodName GetOwnerSid
    Require ($ownerResult.ReturnValue -eq 0 -and $ownerResult.Sid -ceq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'STUDIO_AGENT_OWNER_MISMATCH'
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
    $git=(Get-Command git.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
    Ordinary $git $false
    $python=''
    if($EnablePython){
        $python=(Get-Command python.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
        Ordinary $python $false
        foreach($test in @('test_fisheye_calibration.py','test_calibration_map_integrity.py','test_relative_surface.py','test_projector_coverage.py')){
            Ordinary (Join-Path $root ('tests\'+$test)) $false
        }
    }
    $extra=ExtraStudioProfiles $root $python $git
    foreach($name in $extra.Keys){$wanted[$name]=$extra[$name]}
    # Admit these extra profiles only when the running, tracked-clean
    # CodeBridge runtime actually contains the reviewed bundled helper.
    $qaHelper=Join-Path $runtime 'scripts\studio-exact-head-qa.mjs'
    if(Test-Path -LiteralPath $qaHelper -PathType Leaf){
        Ordinary $qaHelper $false
        $null=& git.exe -C $runtime ls-files --error-unmatch -- 'scripts/studio-exact-head-qa.mjs' 2>$null
        Require ($LASTEXITCODE -eq 0) 'STUDIO_QA_HELPER_UNTRACKED'
        $state=[IO.Path]::GetFullPath([string]$cfg.stateDir)
        Require ($state -ieq (Join-Path $base 'state')) 'STUDIO_QA_STATE_SCOPE_MISMATCH'
        Ordinary $state $true
        PrivateAcl $state
        $exact=ExactStudioProfiles $node $runtime $state $cmake $ctest $qt ([bool]$EnableHardware)
        foreach($name in $exact.Keys){$wanted[$name]=$exact[$name]}
        Write-Output 'STUDIO_EXACT_QA_PROFILE=READY'
    }else{
        Write-Output 'STUDIO_EXACT_QA_PROFILE=NEW_RUNTIME_REQUIRED'
    }
    if($EnablePackaging){
        $packageHelper=Join-Path $runtime 'scripts\studio-locked-package.mjs'
        Ordinary $packageHelper $false
        Ordinary $qaHelper $false
        $null=& git.exe -C $runtime ls-files --error-unmatch -- 'scripts/studio-locked-package.mjs' 'scripts/studio-exact-head-qa.mjs' 2>$null
        Require ($LASTEXITCODE -eq 0) 'STUDIO_PACKAGE_HELPER_UNTRACKED'
        $packageState=[IO.Path]::GetFullPath([string]$cfg.stateDir)
        Require ($packageState -ieq (Join-Path $base 'state')) 'STUDIO_PACKAGE_STATE_SCOPE_MISMATCH'
        Ordinary $packageState $true
        PrivateAcl $packageState
        $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Ordinary $ps $false
        $wanted.calibration_studio_package=StudioPackageProfile $node $runtime $packageState $git $ps $qt
        Write-Output 'STUDIO_PACKAGE_PROFILE=READY'
    }
    $changed=AddProfiles $p $wanted
    $newSupervisor=$false
    if($EnableSupervisor){
        $supFile=Join-Path $base 'studio-supervisor.json'
        $token=Join-Path $base 'studio-supervisor.token'
        $startup=[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
        Ordinary $startup $true
        $shortcut=Join-Path $startup 'KMJ CodeBridge Studio Supervisor.lnk'
        $pipe='\\.\pipe\'+$studioPipeName
        Require ($null -eq $cfg.PSObject.Properties['supervisorSocket']) 'STUDIO_SUPERVISOR_SOCKET_CONFLICT'
        $bound=($null -ne $cfg.PSObject.Properties['supervisorPipe']) -or ($null -ne $cfg.PSObject.Properties['supervisorTokenFile'])
        if($bound){
            Require ($null -ne $cfg.PSObject.Properties['supervisorPipe'] -and $null -ne $cfg.PSObject.Properties['supervisorTokenFile']) 'STUDIO_SUPERVISOR_BINDING_INCOMPLETE'
            Require ($cfg.supervisorPipe -ceq $pipe -and $cfg.supervisorTokenFile -ieq $token) 'STUDIO_SUPERVISOR_BINDING_CONFLICT'
            Ordinary $supFile $false
            Ordinary $token $false
            PrivateAcl $supFile
            PrivateAcl $token
            Ordinary $shortcut $false
            Require (ProbeStudioSupervisor $node $runtime $supFile) 'STUDIO_SUPERVISOR_EXISTING_NOT_VERIFIED'
            Write-Output 'STUDIO_SUPERVISOR_HMAC=PASS'
        }else{
            foreach($file in @($supFile,$token,$shortcut)){Require (!(Test-Path -LiteralPath $file)) 'STUDIO_SUPERVISOR_EXISTING_REVIEW'}
            $cfg|Add-Member -MemberType NoteProperty -Name supervisorPipe -Value $pipe
            $cfg|Add-Member -MemberType NoteProperty -Name supervisorTokenFile -Value $token
            $newSupervisor=$true
            $changed=$true
        }
    }
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
        ValidateStagedConfig $node $runtime $tmp
        Write-Output 'STUDIO_STAGED_SCHEMA=PASS'
        Require ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ceq $originalHash) 'STUDIO_CONFIG_MOVED'
        if(!(Test-Path -LiteralPath $evidence)){
            New-Item -ItemType Directory -Path $evidence|Out-Null
        }
        Ordinary $evidence $true
        if($newSupervisor){
            InstallStudioSupervisor $node $cli $runtime $root $config $supFile $token $shortcut
            Require ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ceq $originalHash) 'STUDIO_CONFIG_MOVED_AFTER_SUPERVISOR'
        }
        [IO.File]::Replace($tmp,$config,$backup)
        PrivateAcl $config
        PrivateAcl $backup
        $check=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json
        Require ($check.id -ceq $device -and @($check.projects).Count -eq 1 -and $check.projects[0].id -ceq $project) 'STUDIO_CONFIG_POSTWRITE_SCOPE'
        foreach($name in $wanted.Keys){
            Require ($check.projects[0].commands.PSObject.Properties.Name -ccontains $name) 'STUDIO_CONFIG_POSTWRITE_PROFILE'
        }
        if($EnableSupervisor){
            Require ($check.supervisorPipe -ceq $pipe -and $check.supervisorTokenFile -ieq $token) 'STUDIO_SUPERVISOR_POSTWRITE_BINDING'
            Write-Output 'STUDIO_SUPERVISOR_BINDING=CONFIG_APPLIED'
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
    # Bounded, non-secret local diagnostics for the real preflight as well.
    Write-Output ('STUDIO_ERROR_LINE='+$_.InvocationInfo.ScriptLineNumber)
    Write-Output ('STUDIO_ERROR_TYPE='+$_.Exception.GetType().Name)
    $code=[string]$_.Exception.Message
    if($code -notmatch '^STUDIO_[A-Z0-9_]{3,100}$'){$code='STUDIO_LOCAL_PRECONDITION_FAILED'}
    Write-Output ('STUDIO_DEV=BLOCKED:'+$code)
    Write-Output 'SECRET_OUTPUT=NONE'
    exit 2
}
