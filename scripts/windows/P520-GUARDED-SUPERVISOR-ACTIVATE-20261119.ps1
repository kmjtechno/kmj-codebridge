# P520 existing-only Supervisor guarded activation. Owner-only, NO new task or agent takeover.
# Default is READ_ONLY. -Apply enables/starts ONLY the one already-installed,
# SHA-pinned disabled task after live identity, ACL, and ephemeral HMAC gates.
# On persistent HMAC failure it STOPs/DISABLEs the task; never touches agent.json,
# signing keys, production, database, backups, or other Windows agents.
[CmdletBinding()]
param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Mark([string]$key,[string]$value) { Write-Output ($key+'='+$value) }
function Block([string]$code) { throw $code }
function Need([bool]$ok,[string]$code) { if(-not $ok) { Block $code } }
function Same([string]$a,[string]$b) {
  try {
    return [string]::Equals(
      [IO.Path]::GetFullPath($a).TrimEnd('\'),
      [IO.Path]::GetFullPath($b).TrimEnd('\'),
      [StringComparison]::OrdinalIgnoreCase
    )
  } catch { return $false }
}
function Pinned([string]$path,[string]$sha) {
  $f=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  Need (-not $f.PSIsContainer -and
        ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'SCRIPT_TYPE_OR_LINK_UNTRUSTED'
  Need ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $sha) 'SCRIPT_SHA_MISMATCH'
}
function TaskExact {
  $items=@(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $_.TaskName -ieq 'KMJ-CodeBridge-Supervisor-P520'
  })
  Need ($items.Count -eq 1) 'TASK_NOT_UNIQUE'
  $task=$items[0]
  Need ([string]$task.TaskPath -ceq '\') 'TASK_WRONG_NAMESPACE'
  Need ([string]$task.State -ceq 'Disabled') 'TASK_NOT_DISABLED'
  Need (@($task.Actions).Count -eq 1) 'TASK_ACTION_NOT_UNIQUE'
  $root=Join-Path $env:ProgramData 'KMJ-CodeBridge\P520'
  $release=Join-Path $root 'releases\b652b29beafb9b14e42b0078bfb9571fef5b3271'
  $cli=Join-Path $release 'src\cli.js'
  $config=Join-Path $root 'supervisor.json'
  $action=$task.Actions[0]
  $expectedArgs='"'+$cli+'" windows-supervisor "'+$config+'"'
  Need ([IO.Path]::GetFileName([string]$action.Execute) -ieq 'node.exe' -and
        [string]$action.Arguments -ceq $expectedArgs -and
        (Same ([string]$action.WorkingDirectory) $release)) 'TASK_ACTION_CHANGED'
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  Need (Same ([string]$action.Execute) $node) 'NODE_IDENTITY_CHANGED'
  $me=[Security.Principal.WindowsIdentity]::GetCurrent()
  $serviceId=[string]$task.Principal.UserId
  Need (-not [string]::IsNullOrWhiteSpace($serviceId)) 'TASK_PRINCIPAL_MISSING'
  $sid=([Security.Principal.NTAccount]::new($serviceId)).Translate(
    [Security.Principal.SecurityIdentifier]).Value
  Need ($sid -ceq $me.User.Value) 'TASK_PRINCIPAL_OWNER_MISMATCH'
  Need ([string]$task.Principal.RunLevel -ceq 'Limited') 'TASK_RUNLEVEL_CHANGED'
  Need ([string]$task.Principal.LogonType -ceq 'S4U') 'TASK_LOGON_TYPE_CHANGED'
  Need (@($task.Triggers).Count -ge 1) 'TASK_STARTUP_TRIGGER_MISSING'
  return $node
}
function CheckDoctor([string]$path,[string[]]$markers) {
  $output=@(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $path 2>$null)
  Need ($LASTEXITCODE -eq 0) 'PINNED_DOCTOR_FAILED'
  foreach($marker in $markers) {
    Need ($output -ccontains $marker) 'PINNED_DOCTOR_MARKER_MISSING'
  }
}
$enabled=$false
$taskName='KMJ-CodeBridge-Supervisor-P520'
try {
  Need ($env:OS -ceq 'Windows_NT' -and
        $env:COMPUTERNAME -ieq 'DESKTOP-5FVJMET' -and
        [Environment]::Is64BitOperatingSystem) 'WRONG_P520_DEVICE'
  $doctor=Join-Path $PSScriptRoot 'P520-SUPERVISOR-EXISTING-TASK-DOCTOR-20261118.ps1'
  $smoke=Join-Path $PSScriptRoot 'P520-SUPERVISOR-EPHEMERAL-HMAC-LAUNCH-20261118.ps1'
  $verify=Join-Path $PSScriptRoot 'P520-PERSISTENT-HMAC-VERIFY-20261119.mjs'
  Pinned $doctor '7326fcc54aca02bd57ed9d220380eddc5ffeda26f393aa9fdda1fa0adf4b4a5d'
  Pinned $smoke 'a727ea6ba818858947079a59a7f29373e35cdace859393e2959b7d275fe942af'
  Pinned $verify 'e66d268f2e9a199a1d450c40b27249232c54d8ce179d6885a49371c676973b4d'
  $node=TaskExact
  CheckDoctor $doctor @(
    'P520_DEVICE=PASS','P520_EXISTING_TASK=ONE',
    'P520_EXISTING_TASK_DISABLED=PASS','P520_TASK_ACTION_PIN=PASS',
    'P520_PINNED_RELEASE=PASS','P520_SUPERVISOR_CONFIG=PASS',
    'P520_TOKEN_ACL=PASS','P520_READONLY_DOCTOR=PASS_STAGED_ONLY'
  )
  CheckDoctor $smoke @(
    'P520_EXISTING_DISABLED_TASK=PASS',
    'P520_HMAC_REJECTS_BAD_MAC=PASS',
    'P520_HMAC_AUTHENTICATED_STATUS=PASS',
    'P520_HMAC_AUTHENTICATED_CONFIG=PASS',
    'P520_NO_RESTART_CAPABILITY=PASS',
    'P520_EPHEMERAL_LAUNCH=PASS',
    'P520_SCHEDULED_TASK_STILL_DISABLED=PASS'
  )
  $node=TaskExact
  Mark 'P520_EXACT_EXISTING_TASK' 'PASS'
  Mark 'P520_PINNED_SOURCE_AND_HMAC' 'PASS'
  if(-not $Apply) {
    Mark 'P520_GUARDED_ACTIVATION' 'DRY_RUN_PASS'
    Mark 'P520_EXISTING_TASK_MUTATION' 'NONE'
    Mark 'P520_AGENT_BINDING' 'NOT_CHANGED'
    Mark 'P520_PHYSICAL_RESTORE' 'NOT_EXECUTED'
    Mark 'PRODUCTION_APPROVAL' 'NOT_GRANTED'
    exit 0
  }
  $me=[Security.Principal.WindowsIdentity]::GetCurrent()
  $admin=New-Object Security.Principal.WindowsPrincipal($me)
  Need ($admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'ELEVATED_OWNER_REQUIRED'
  $node=TaskExact
  Enable-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop | Out-Null
  $enabled=$true
  Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
  $verified=$false
  for($attempt=0;$attempt -lt 15;$attempt++) {
    try {
      $result=@(& $node $verify 2>$null)
      if($LASTEXITCODE -eq 0 -and
         $result -ccontains 'P520_PERSISTENT_HMAC_STATUS=PASS' -and
         $result -ccontains 'P520_PERSISTENT_HMAC_CONFIG=PASS' -and
         $result -ccontains 'P520_NO_RESTART_CAPABILITY=PASS') {
        $verified=$true
        break
      }
    } catch {}
    Start-Sleep -Seconds 1
  }
  Need $verified 'PERSISTENT_HMAC_NOT_VERIFIED'
  $after=@(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $_.TaskName -ieq $taskName
  })
  Need ($after.Count -eq 1 -and [string]$after[0].TaskPath -ceq '\' -and
        [string]$after[0].State -in @('Ready','Running','Queued')) 'TASK_READBACK_NOT_ACTIVE'
  Mark 'P520_GUARDED_ACTIVATION' 'PASS'
  Mark 'P520_PERSISTENT_HMAC' 'PASS'
  Mark 'P520_AGENT_BINDING' 'NOT_CHANGED'
  Mark 'P520_PHYSICAL_RESTORE' 'NOT_EXECUTED'
  Mark 'PRODUCTION_APPROVAL' 'NOT_GRANTED'
} catch {
  $code=[string]$_.Exception.Message
  if($code -notmatch '^[A-Z][A-Z0-9_]{3,90}$') { $code='REVIEW_REQUIRED' }
  if($enabled) {
    try {
      Stop-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
      Disable-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop | Out-Null
      $readback=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
      if([string]$readback.State -ceq 'Disabled') { Mark 'P520_TASK_ROLLBACK' 'PASS_DISABLED' }
      else { Mark 'P520_TASK_ROLLBACK' 'FAIL_REVIEW_REQUIRED' }
    } catch { Mark 'P520_TASK_ROLLBACK' 'FAIL_REVIEW_REQUIRED' }
  }
  Mark 'P520_GUARDED_ACTIVATION' ('BLOCKED_'+$code)
  Mark 'P520_AGENT_BINDING' 'NOT_CHANGED'
  Mark 'P520_PHYSICAL_RESTORE' 'NOT_EXECUTED'
  Mark 'PRODUCTION_APPROVAL' 'NOT_GRANTED'
  exit 2
}
