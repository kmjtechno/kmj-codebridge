# KMJ P520 EXISTING-ONLY CodeBridge agent binding handoff.
# Dry-run by default. -Apply changes only one owner-pinned existing agent.json
# and restarts its single existing process after idle, HMAC and rollback checks.
# Never registers a task, changes Supervisor keys, enrolls a new device,
# changes Main Platform production or performs database restore.
[CmdletBinding()]
param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Need([bool]$condition,[string]$code) { if(-not $condition){ throw $code } }
function Mark([string]$key,[string]$value) { Write-Output ($key+'='+$value) }
function Same([string]$a,[string]$b) {
  try {
    return [string]::Equals(
      [IO.Path]::GetFullPath($a).TrimEnd('\'),
      [IO.Path]::GetFullPath($b).TrimEnd('\'),
      [StringComparison]::OrdinalIgnoreCase
    )
  } catch { return $false }
}
function Sha([string]$p) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $p -ErrorAction Stop).Hash.ToLowerInvariant()
}
function Ordinary([string]$p,[bool]$directory) {
  $v=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  Need ([bool]$v.PSIsContainer -eq $directory -and
        ($v.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'UNTRUSTED_FILE_OR_DIRECTORY'
}
function Pinned([string]$p,[string]$sha) {
  Ordinary $p $false
  Need ((Sha $p) -ceq $sha) 'REVIEWED_SOURCE_SHA_MISMATCH'
}
function ScopedAgents([string]$config) {
  $all=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
  Need ($all.Count -le 64) 'AGENT_PROCESS_INVENTORY_UNBOUNDED'
  return @($all | Where-Object {
    $_.CommandLine -and
    [string]$_.CommandLine -match '(?i)src[\\/]cli\.js["'']?\s+agent\s+' -and
    [string]$_.CommandLine -like ('*'+[WildcardPattern]::Escape($config)+'*')
  })
}
function AssertIdle([string]$state) {
  Ordinary $state $true
  foreach($folder in @('jobs','autopilot')) {
    $dir=Join-Path $state $folder
    Ordinary $dir $true
    $items=@(Get-ChildItem -LiteralPath $dir -File -Recurse -Filter '*.json' -ErrorAction Stop |
      Select-Object -First 3001)
    Need ($items.Count -le 3000) 'AGENT_JOB_INVENTORY_UNBOUNDED'
    foreach($item in $items) {
      Need ($item.Length -le 4194304 -and
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'AGENT_JOB_JOURNAL_UNTRUSTED'
      try { $data=Get-Content -LiteralPath $item.FullName -Raw -ErrorAction Stop |
               ConvertFrom-Json -ErrorAction Stop }
      catch { throw 'AGENT_JOB_JOURNAL_CORRUPT' }
      if($folder -ceq 'jobs') {
        Need ($null -ne $data.PSObject.Properties['state']) 'AGENT_JOB_STATE_MISSING'
        Need ([string]$data.state -notin @('running','queued')) 'AGENT_BUSY'
      } else {
        Need ($null -ne $data.PSObject.Properties['tasks']) 'AGENT_TASKS_MISSING'
        foreach($task in @($data.tasks)) {
          Need ([string]$task.state -cne 'running') 'AGENT_AUTOPILOT_ACTIVE'
        }
      }
    }
  }
}
function ConfirmHeartbeat([int]$id,[string]$entry,[string]$config,[string]$state,[datetime]$since) {
  for($i=0;$i -lt 20;$i++) {
    Start-Sleep -Seconds 2
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id) -ErrorAction SilentlyContinue
    if($null -eq $process -or
       [string]$process.CommandLine -notlike ('*'+[WildcardPattern]::Escape($entry)+'*')) {
      return $false
    }
    $agents=@(ScopedAgents $config)
    if($agents.Count -ne 1 -or [int]$agents[0].ProcessId -ne $id) { return $false }
    $connection=Join-Path $state 'connection.json'
    if(Test-Path -LiteralPath $connection -PathType Leaf) {
      try {
        $obj=Get-Content -LiteralPath $connection -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $stamp=[datetime]::Parse([string]$obj.connectedAt).ToUniversalTime()
        if($stamp -ge $since.AddSeconds(-2)) { return $true }
      } catch {}
    }
  }
  return $false
}
function StartScoped([string]$node,[string]$entry,[string]$config,[string]$repo) {
  $args='"'+$entry+'" agent "'+$config+'"'
  $p=Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $repo -WindowStyle Hidden -PassThru -ErrorAction Stop
  return [int]$p.Id
}

$root=Join-Path $env:ProgramData 'KMJ-CodeBridge\P520'
$supervisorFile=Join-Path $root 'supervisor.json'
$taskName='KMJ-CodeBridge-Supervisor-P520'
$doctor=Join-Path $PSScriptRoot 'P520-EXACT-AGENT-BINDING-PREFLIGHT-20261119.mjs'
$hmac=Join-Path $PSScriptRoot 'P520-PERSISTENT-HMAC-VERIFY-20261119.mjs'
$switched=$false
$oldStopped=$false
$newPid=0
$oldPid=0
$backup=$null
$originalHash=$null
$entry=$null
$config=$null
$state=$null
$repo=$null
$node=$null
try {
  Need ($env:OS -ceq 'Windows_NT' -and
        $env:COMPUTERNAME -ieq 'DESKTOP-5FVJMET' -and
        [Environment]::Is64BitOperatingSystem) 'WRONG_P520_DEVICE'
  Ordinary $root $true
  Ordinary $supervisorFile $false
  Pinned $doctor '3bd126fb9901c91cf32dfdbdd4362bb29f37dc99bbc7da01a138674f6cc723a9'
  Pinned $hmac 'e66d268f2e9a199a1d450c40b27249232c54d8ce179d6885a49371c676973b4d'
  $task=@(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $_.TaskName -ieq $taskName
  })
  Need ($task.Count -eq 1 -and [string]$task[0].TaskPath -ceq '\' -and
        [string]$task[0].State -ceq 'Running') 'SUPERVISOR_EXISTING_TASK_NOT_RUNNING'
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  Need (Same ([string]$task[0].Actions[0].Execute) $node) 'SUPERVISOR_NODE_IDENTITY_CHANGED'
  $hmacResult=@(& $node $hmac 2>$null)
  Need ($LASTEXITCODE -eq 0 -and
        $hmacResult -ccontains 'P520_PERSISTENT_HMAC_STATUS=PASS' -and
        $hmacResult -ccontains 'P520_PERSISTENT_HMAC_CONFIG=PASS') 'SUPERVISOR_HMAC_NOT_AUTHENTICATED'
  $proposalResult=@(& $node $doctor --inspect 2>$null)
  Need ($LASTEXITCODE -eq 0 -and
        $proposalResult -ccontains 'P520_AGENT_PROPOSAL_EXACT_ONLY=PASS' -and
        $proposalResult -ccontains 'P520_AGENT_BINDING_PREFLIGHT=PASS') 'EXACT_AGENT_PROPOSAL_NOT_ATTESTED'
  $supervisor=Get-Content -LiteralPath $supervisorFile -Raw -ErrorAction Stop |
    ConvertFrom-Json -ErrorAction Stop
  $config=[string]$supervisor.agent.configPath
  Ordinary $config $false
  Ordinary ($config+'.proposed') $false
  $agent=Get-Content -LiteralPath $config -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  $state=[string]$agent.stateDir
  Need (-not [string]::IsNullOrWhiteSpace($state) -and [IO.Path]::IsPathRooted($state)) 'AGENT_STATE_DIR_UNVERIFIED'
  AssertIdle $state
  $agents=@(ScopedAgents $config)
  Need ($agents.Count -eq 1) 'AGENT_PROCESS_NOT_UNIQUE'
  $oldPid=[int]$agents[0].ProcessId
  Need (Same ([string]$agents[0].ExecutablePath) $node) 'AGENT_EXECUTABLE_CHANGED'
  $me=[Security.Principal.WindowsIdentity]::GetCurrent()
  $owner=Invoke-CimMethod -InputObject $agents[0] -MethodName GetOwnerSid -ErrorAction Stop
  Need ([string]$owner.Sid -ceq $me.User.Value) 'AGENT_OWNER_SID_MISMATCH'
  # Extract only an exactly quoted original Node CLI path; don't reconstruct
  # a command from a caller path, Git checkout, backup, or environment input.
  $line=[string]$agents[0].CommandLine
  $match=[regex]::Match($line,'(?i)"(?<entry>[A-Z]:\\[^"]+[\\/]src[\\/]cli\.js)"\s+agent\s+"(?<config>[A-Z]:\\[^"]+[\\/]agent\.json)"\s*$')
  Need ($match.Success -and (Same ([string]$match.Groups['config'].Value) $config)) 'AGENT_COMMANDLINE_UNTRUSTED'
  $entry=[string]$match.Groups['entry'].Value
  Ordinary $entry $false
  $repo=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $entry) '..'))
  Ordinary $repo $true
  $git=(Get-Command git.exe -ErrorAction Stop).Source
  $head=[string]((& $git --no-optional-locks -C $repo rev-parse HEAD 2>$null) | Select-Object -First 1)
  Need ($LASTEXITCODE -eq 0 -and
        $head.Trim() -ceq '4f0a96ceba203315262da219d51b554e716355c9') 'AGENT_RUNNING_SOURCE_SHA_MISMATCH'
  $origin=[string]((& $git --no-optional-locks -C $repo remote get-url origin 2>$null) | Select-Object -First 1)
  Need ($LASTEXITCODE -eq 0 -and
        $origin.Trim() -cin @('https://github.com/kmjtechno/kmj-codebridge.git',
                             'https://github.com/kmjtechno/kmj-codebridge')) 'AGENT_RUNNING_SOURCE_ORIGIN_MISMATCH'
  $tracked=@(& $git --no-optional-locks -C $repo status --porcelain=v1 --untracked-files=no 2>$null)
  Need ($LASTEXITCODE -eq 0 -and $tracked.Count -eq 0) 'AGENT_RUNNING_SOURCE_TRACKED_DIRTY'
  $originalHash=Sha $config
  $proposalHash=Sha ($config+'.proposed')
  Mark 'P520_AGENT_HANDOFF_PREFLIGHT' 'PASS'
  Mark 'P520_SUPERVISOR_PERSISTENT_HMAC' 'PASS'
  Mark 'P520_EXISTING_AGENT' 'ONE_PINNED'
  if(-not $Apply) {
    Mark 'P520_AGENT_HANDOFF_MODE' 'READ_ONLY'
    Mark 'P520_AGENT_RESTART' 'NOT_EXECUTED'
    Mark 'P520_PHYSICAL_RESTORE' 'NOT_EXECUTED'
    Mark 'PRODUCTION_APPROVAL' 'NOT_GRANTED'
    exit 0
  }
  $admin=New-Object Security.Principal.WindowsPrincipal($me)
  Need ($admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'P520_ELEVATED_OWNER_REQUIRED'
  AssertIdle $state
  $again=@(ScopedAgents $config)
  Need ($again.Count -eq 1 -and [int]$again[0].ProcessId -eq $oldPid -and
        (Sha $config) -ceq $originalHash -and
        (Sha ($config+'.proposed')) -ceq $proposalHash) 'AGENT_CHANGED_DURING_ADMISSION'
  $nonce=[guid]::NewGuid().ToString('N')
  $temp=$config+'.p520-'+$nonce+'.tmp'
  $backup=$config+'.p520-'+$nonce+'.backup'
  Need (-not(Test-Path -LiteralPath $temp) -and
        -not(Test-Path -LiteralPath $backup)) 'AGENT_BACKUP_COLLISION'
  Copy-Item -LiteralPath ($config+'.proposed') -Destination $temp -ErrorAction Stop
  Set-Acl -LiteralPath $temp -AclObject (Get-Acl -LiteralPath $config) -ErrorAction Stop
  [IO.File]::Replace($temp,$config,$backup)
  $switched=$true
  Need ((Sha $config) -ceq $proposalHash -and (Sha $backup) -ceq $originalHash) 'AGENT_ATOMIC_BACKUP_SHA_MISMATCH'
  Mark 'P520_AGENT_BACKUP' 'VERIFIED_SAME_DIRECTORY'
  $oldStopped=$true
  Stop-Process -Id $oldPid -ErrorAction Stop
  for($i=0;$i -lt 20;$i++) {
    if(-not(Get-Process -Id $oldPid -ErrorAction SilentlyContinue)){break}
    Start-Sleep -Milliseconds 500
  }
  Need (-not(Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) 'AGENT_OLD_PROCESS_DID_NOT_STOP'
  Need (@(ScopedAgents $config).Count -eq 0) 'AGENT_AUTORESTART_COLLISION'
  $since=[datetime]::UtcNow
  $newPid=StartScoped $node $entry $config $repo
  Need (ConfirmHeartbeat $newPid $entry $config $state $since) 'AGENT_NEW_HEARTBEAT_NOT_ATTESTED'
  $hmacAfter=@(& $node $hmac 2>$null)
  Need ($LASTEXITCODE -eq 0 -and
        $hmacAfter -ccontains 'P520_PERSISTENT_HMAC_STATUS=PASS') 'AGENT_POSTHANDOFF_HMAC_FAILED'
  Mark 'P520_AGENT_HANDOFF' 'PASS'
  Mark 'P520_AGENT_RECONNECTED' 'PASS'
  Mark 'P520_SUPERVISOR_PIPE_BINDING' 'APPLIED_VERIFY_REMOTE'
  Mark 'P520_PHYSICAL_RESTORE' 'NOT_EXECUTED'
  Mark 'PRODUCTION_APPROVAL' 'NOT_GRANTED'
} catch {
  $code=[string]$_.Exception.Message
  if($code -cnotmatch '^[A-Z][A-Z0-9_]{3,100}$') { $code='UNKNOWN_PRECONDITION' }
  if($switched) {
    try {
      if($newPid -gt 0 -and (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $newPid -ErrorAction Stop
      }
      Need (-not [string]::IsNullOrWhiteSpace($backup) -and
            (Test-Path -LiteralPath $backup -PathType Leaf) -and
            (Sha $backup) -ceq $originalHash) 'ROLLBACK_BACKUP_NOT_ATTESTED'
      $restore=$config+'.rollback-'+[guid]::NewGuid().ToString('N')+'.tmp'
      Copy-Item -LiteralPath $backup -Destination $restore -ErrorAction Stop
      Set-Acl -LiteralPath $restore -AclObject (Get-Acl -LiteralPath $config) -ErrorAction Stop
      [IO.File]::Replace($restore,$config,$null)
      Need ((Sha $config) -ceq $originalHash) 'ROLLBACK_CONFIG_HASH_MISMATCH'
      Mark 'P520_AGENT_CONFIG_ROLLBACK' 'PASS'
      if($oldStopped) {
        Need (@(ScopedAgents $config).Count -eq 0) 'ROLLBACK_DUPLICATE_AGENT_PRESENT'
        $reconnectAt=[datetime]::UtcNow
        $pid=StartScoped $node $entry $config $repo
        Need (ConfirmHeartbeat $pid $entry $config $state $reconnectAt) 'ROLLBACK_HEARTBEAT_UNVERIFIED'
        Mark 'P520_AGENT_RESTART_ROLLBACK' 'PASS'
      }
    } catch {
      Mark 'P520_AGENT_ROLLBACK' 'FAILED_OWNER_RECOVERY_REQUIRED'
    }
  }
  Mark 'P520_AGENT_HANDOFF' ('BLOCKED_'+$code)
  Mark 'P520_PHYSICAL_RESTORE' 'NOT_EXECUTED'
  Mark 'PRODUCTION_APPROVAL' 'NOT_GRANTED'
  exit 2
}
