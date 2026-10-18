<#
.SYNOPSIS
  Run a fixed, credential-free P720 LOCAL SERVICE one-shot canary.
.DESCRIPTION
  Dry-run by default. -Apply creates ONLY a transient no-trigger canary task
  and a new staging directory, runs a one-shot read-only identity probe, and
  removes only its own unmodified task and files. Never starts, changes or
  terminates a CodeBridge agent or its existing Scheduled Task.
#>
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'KMJ-CodeBridge-P720-LocalService-Canary'
$OriginalTask = 'KMJ-CodeBridge-P720-Agent'
$Root = 'D:\KMJ-HyperSpeed'
$Pinned = 'e3587be842dcc701236b54a2e1de90238a5c3429'
$Entry = Join-Path $Root "codebridge-releases\$Pinned\src\cli.js"
$Config = Join-Path $Root 'private\p720-codebridge\agent.json'
$Dir = Join-Path $env:ProgramData 'KMJ-P720-CodeBridge-LocalService-Canary'
$EvidenceDir = Join-Path $Dir 'evidence'
$StartedReceipt = Join-Path $EvidenceDir 'started.txt'
$ResultReceipt = Join-Path $EvidenceDir 'result.txt'
$Dst = Join-Path $Dir 'CANARY-P720-LOCALSERVICE.ps1'
$Url = 'https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/2f08280b998d809fea4bc8a8badd30fa8d069cce/scripts/windows/CANARY-P720-LOCALSERVICE.ps1'
$Expected = '60848d3810f01364583abbdbc67c0fedf9540b9a'
$Tmp = Join-Path $env:TEMP ('kmj-p720-canary-' + $PID + '.ps1')
$created = $false
$evidenceCreated = $false
$registered = $false
$removed = $false
$exitCode = 2
$cleanup = 'NOT_NEEDED'
$taskCleanup = 'NOT_NEEDED'
$stageCleanup = 'NOT_NEEDED'
$taskArgs = ''

function SidOf([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
  try {
    if ($Name.StartsWith('S-1-', [StringComparison]::OrdinalIgnoreCase)) {
      return ([Security.Principal.SecurityIdentifier]::new($Name)).Value
    }
    return ([Security.Principal.NTAccount]::new($Name)).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch { return $null }
}
function AssertOriginal {
  $task = Get-ScheduledTask -TaskName $OriginalTask -TaskPath '\' -ErrorAction Stop
  $args = '"' + $Entry + '" agent "' + $Config + '"'
  if ([string]$task.State -cne 'Disabled' -or @($task.Actions).Count -ne 1 -or
      [string]$task.Actions[0].Arguments -cne $args) {
    throw 'CANARY_ORIGINAL_TASK_CHANGED'
  }
  $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
  if (@($nodes | Where-Object { -not $_.CommandLine }).Count -gt 0) {
    throw 'CANARY_PROCESS_VISIBILITY_INCOMPLETE'
  }
  $agents = @($nodes | Where-Object {
    $_.CommandLine.IndexOf($Entry,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine.IndexOf($Config,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -match '\bagent\b'
  })
  if ($agents.Count -ne 1) { throw 'CANARY_AGENT_NOT_UNIQUE' }
  $lock = Get-Content -LiteralPath (Join-Path $Root 'private\p720-codebridge\state\agent.lock') -Raw | ConvertFrom-Json
  if ([int]$lock.pid -ne [int]$agents[0].ProcessId -or
      [string]::IsNullOrWhiteSpace([string]$lock.owner)) {
    throw 'CANARY_AGENT_LOCK_CHANGED'
  }
}
function ReceiptValue([string]$Path, [string[]]$Allowed) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.Length -gt 96 -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'CANARY_RECEIPT_UNTRUSTED'
  }
  $value = (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop).Trim()
  if ($value -notin $Allowed) { throw 'CANARY_RECEIPT_VALUE_INVALID' }
  return $value
}
function VerifyOurTask([object]$Task) {
  $triggers = @($Task.Triggers | Where-Object { $null -ne $_ })
  if ((SidOf ([string]$Task.Principal.UserId)) -cne 'S-1-5-19' -or
      [string]$Task.Principal.LogonType -cne 'ServiceAccount' -or
      $triggers.Count -ne 0 -or @($Task.Actions).Count -ne 1 -or
      [string]$Task.Actions[0].Arguments -cne $taskArgs) {
    throw 'CANARY_TASK_SCOPE_CHANGED'
  }
}

Write-Output 'KMJ_P720_LOCALSERVICE_CANARY_MODE=FIXED_SCOPE'
Write-Output 'AGENT_ORIGINAL_TASK_AND_CHECKOUT=UNTOUCHED'
Write-Output 'SECRETS_AND_COMMAND_LINES=HIDDEN'
Write-Output 'AUTHENTICATED_GATEWAY=NOT_PROVEN'
Write-Output 'MANAGED_TAKEOVER=NOT_AUTHORIZED'

try {
  if ($env:OS -ne 'Windows_NT') { throw 'CANARY_WINDOWS_ONLY' }
  $principal = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
  )
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'CANARY_ADMIN_REQUIRED'
  }
  if (Test-Path -LiteralPath $Dir) { throw 'CANARY_STAGE_ALREADY_EXISTS' }
  if (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue) {
    throw 'CANARY_TASK_ALREADY_EXISTS'
  }
  AssertOriginal
  Write-Output 'KMJ_P720_LOCALSERVICE_ORIGINAL_AGENT=UNIQUE_LOCK_MATCH'
  Write-Output 'KMJ_P720_LOCALSERVICE_ORIGINAL_TASK=DISABLED_UNTOUCHED'
  if (-not $Apply) {
    Write-Output 'KMJ_P720_LOCALSERVICE_CANARY=DRY_RUN_PASS'
    $exitCode = 0
  } else {
    Write-Output 'KMJ_P720_LOCALSERVICE_CANARY=ONE_SHOT_TEST'
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing -ErrorAction Stop
    $actual = (& $git hash-object -- $Tmp)
    if ($LASTEXITCODE -ne 0 -or [string]$actual -cne $Expected) {
      throw 'CANARY_PINNED_SOURCE_INVALID'
    }
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $self = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Tmp -SelfTest
    if ($LASTEXITCODE -ne 0 -or [string]::Join(' ',[string[]]$self) -notmatch 'KMJ_P720_SERVICE_CANARY_SELFTEST=PASS') {
      throw 'CANARY_SELFTEST_FAILED'
    }
    New-Item -ItemType Directory -Path $Dir -ErrorAction Stop | Out-Null
    $created = $true
    $aclResult = & icacls.exe $Dir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX'
    if ($LASTEXITCODE -ne 0) { throw 'CANARY_DIRECTORY_ACL_FAILED' }
    Copy-Item -LiteralPath $Tmp -Destination $Dst -ErrorAction Stop
    $aclResult = & icacls.exe $Dst '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:RX'
    if ($LASTEXITCODE -ne 0) { throw 'CANARY_FILE_ACL_FAILED' }
    New-Item -ItemType Directory -Path $EvidenceDir -ErrorAction Stop | Out-Null
    $evidenceCreated = $true
    $aclResult = & icacls.exe $EvidenceDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M'
    if ($LASTEXITCODE -ne 0) { throw 'CANARY_EVIDENCE_ACL_FAILED' }
    $staged = (& $git hash-object -- $Dst)
    if ($LASTEXITCODE -ne 0 -or [string]$staged -cne $Expected) {
      throw 'CANARY_STAGED_SOURCE_INVALID'
    }
    AssertOriginal
    if (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue) {
      throw 'CANARY_TASK_RACE'
    }
    $taskArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Dst + '" -RunAsTask'
    $action = New-ScheduledTaskAction -Execute $ps -Argument $taskArgs -WorkingDirectory $Dir
    $identity = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromSeconds(45)) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Principal $identity -Settings $settings -ErrorAction Stop | Out-Null
    $registered = $true
    VerifyOurTask (Get-ScheduledTask -TaskName $TaskName -TaskPath '\')
    $startedAt = Get-Date
    Start-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
    $done = $false
    $startedProof = $false
    $resultValue = $null
    $lastState = 'UNKNOWN'
    $lastResult = -1
    $schedulerStarted = $false
    $allowedResult = @(
      'PASS_LIMITED','AGENT_CONFIG_NOT_READABLE','SUPERVISOR_TOKEN_NOT_READABLE',
      'AGENT_LOCK_NOT_READABLE','PUBLIC_GATEWAY_HTTPS_UNREACHABLE','UNCLASSIFIED'
    )
    for ($i = 0; $i -lt 45; $i++) {
      Start-Sleep -Seconds 1
      $startedProof = ((ReceiptValue $StartedReceipt @('STARTED')) -eq 'STARTED')
      $resultValue = ReceiptValue $ResultReceipt $allowedResult
      $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
      $lastState = [string](Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop).State
      $lastResult = [long]$info.LastTaskResult
      $schedulerStarted = ($info.LastRunTime -ge $startedAt.AddMinutes(-1))
      # Only a local-service-authored bounded receipt proves what ran.
      # Scheduler LastRunTime may lag or be unavailable: never claim success
      # from its default HRESULT or from a non-running task state alone.
      if ($resultValue -and $startedProof -and $lastState -ne 'Running') {
        $done = $true
        break
      }
    }
    Write-Output "KMJ_P720_LOCALSERVICE_CANARY_START_RECEIPT=$startedProof"
    Write-Output "KMJ_P720_LOCALSERVICE_CANARY_SCHEDULER_STARTED=$schedulerStarted"
    Write-Output "KMJ_P720_LOCALSERVICE_CANARY_TASK_STATE=$lastState"
    Write-Output "KMJ_P720_LOCALSERVICE_CANARY_SCHEDULER_RESULT=$lastResult"
    if (-not $done) {
      if ($startedProof) {
        throw 'CANARY_STARTED_BUT_NO_COMPLETION_RECEIPT'
      }
      throw 'CANARY_TASK_LAUNCH_NOT_PROVEN'
    }
    Write-Output "KMJ_P720_LOCALSERVICE_CANARY_RESULT_RECEIPT=$resultValue"
    if ($resultValue -ceq 'PASS_LIMITED') {
      Write-Output 'KMJ_P720_LOCALSERVICE_CANARY_FILES_AND_PUBLIC_TLS=PASS_LIMITED'
      Write-Output 'KMJ_P720_LOCALSERVICE_CANARY_AUTH_AND_TAKEOVER=UNPROVEN'
      $exitCode = 0
    } else {
      Write-Output 'KMJ_P720_LOCALSERVICE_CANARY_FILES_AND_PUBLIC_TLS=NOT_VERIFIED'
      $exitCode = 3
    }
  }
} catch {
  $reason = [string]$_.Exception.Message
  if ($reason -notmatch '^[A-Z][A-Z0-9_]{3,80}$') { $reason = 'CANARY_UNCLASSIFIED_BLOCKER' }
  Write-Output "KMJ_P720_LOCALSERVICE_CANARY_BLOCKER=$reason"
  $exitCode = 2
} finally {
  if ($registered) {
    try {
      $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
      VerifyOurTask $task
      if ([string]$task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
      }
      Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
      $removed = $true
      $taskCleanup = 'REMOVED'
      $cleanup = 'CANARY_TASK_REMOVED'
    } catch {
      $taskCleanup = 'MANUAL_REVIEW'
      $cleanup = 'CANARY_TASK_MANUAL_REVIEW'
      $exitCode = 4
    }
  }
  if ($created -and (-not $registered -or $removed)) {
    try {
      if ($evidenceCreated) {
        $items = @(Get-ChildItem -LiteralPath $EvidenceDir -Force -ErrorAction Stop)
        foreach ($item in $items) {
          if ($item.PSIsContainer -or
              ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
              $item.Name -notin @('started.txt','result.txt')) {
            throw 'CANARY_EVIDENCE_CLEANUP_UNTRUSTED'
          }
          $allowed = if ($item.Name -eq 'started.txt') {
            @('STARTED')
          } else {
            @('PASS_LIMITED','AGENT_CONFIG_NOT_READABLE',
              'SUPERVISOR_TOKEN_NOT_READABLE','AGENT_LOCK_NOT_READABLE',
              'PUBLIC_GATEWAY_HTTPS_UNREACHABLE','UNCLASSIFIED')
          }
          $value = ReceiptValue $item.FullName $allowed
          if (-not $value) { throw 'CANARY_EVIDENCE_CLEANUP_INVALID' }
          Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
        }
        Remove-Item -LiteralPath $EvidenceDir -ErrorAction Stop
      }
      if (Test-Path -LiteralPath $Dst -PathType Leaf) {
        $git = (Get-Command git.exe -ErrorAction Stop).Source
        $blob = (& $git hash-object -- $Dst)
        if ($LASTEXITCODE -ne 0 -or [string]$blob -cne $Expected) {
          throw 'CANARY_STAGED_FILE_CHANGED'
        }
        Remove-Item -LiteralPath $Dst -Force -ErrorAction Stop
      }
      Remove-Item -LiteralPath $Dir -ErrorAction Stop
      $stageCleanup = 'REMOVED'
      $cleanup = 'OWN_CANARY_FILES_REMOVED'
    } catch {
      $stageCleanup = 'MANUAL_REVIEW'
      $cleanup = 'CANARY_STAGE_MANUAL_REVIEW'
      $exitCode = 4
    }
  }
  if (Test-Path -LiteralPath $Tmp -PathType Leaf) {
    Remove-Item -LiteralPath $Tmp -Force -ErrorAction SilentlyContinue
  }
  Write-Output "KMJ_P720_LOCALSERVICE_CANARY_TASK_CLEANUP=$taskCleanup"
  Write-Output "KMJ_P720_LOCALSERVICE_CANARY_STAGE_CLEANUP=$stageCleanup"
  Write-Output "KMJ_P720_LOCALSERVICE_CANARY_CLEANUP=$cleanup"
  Write-Output 'KMJ_P720_LOCALSERVICE_CANARY_AGENT_MUTATIONS=NONE'
  Write-Output 'KMJ_P720_LOCALSERVICE_CANARY_TAKEOVER=NOT_PERFORMED'
}
exit $exitCode
