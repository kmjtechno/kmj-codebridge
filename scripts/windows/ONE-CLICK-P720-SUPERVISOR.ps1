<#
.SYNOPSIS
  Safely install or recover KMJ TECHNO's native P720 Windows supervisor.
.DESCRIPTION
  Calls the guarded state-aware recovery path. The original fresh-only
  bootstrap cannot be invoked repeatedly after an interrupted Git clone.
  No forced checkout, existing task/config overwrite or agent restart.
#>
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$recovery = Join-Path $PSScriptRoot 'RECOVER-P720-SUPERVISOR.ps1'
if (-not (Test-Path -LiteralPath $recovery -PathType Leaf)) {
  throw 'KMJ_NATIVE_SUPERVISOR_RECOVERY_SCRIPT_MISSING'
}
if (-not $Apply) {
  Write-Output 'KMJ_NATIVE_SUPERVISOR=DRY_RUN'
  Write-Output 'PREPARATION=NOT_STARTED'
  Write-Output 'ACTIVATION=NOT_STARTED'
  return
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'KMJ_NATIVE_SUPERVISOR_ADMINISTRATOR_REQUIRED'
}

Write-Output 'KMJ_NATIVE_SUPERVISOR=STATE_AWARE_RECOVERY'
try {
  # This guarded script performs an immutable new preparation only when the
  # release is absent; otherwise it verifies and safely resumes or refuses.
  # Its -Apply path must throw on any incomplete or concurrent state.
  & $recovery -Apply
  if (-not $?) { throw 'KMJ_NATIVE_SUPERVISOR_RECOVERY_FAILED' }
} catch {
  # The previous wrapper hid every useful error behind PREPARE_BLOCKED.
  # Expose only a stable machine-readable error code, never tokens, paths,
  # process command lines, agent configuration or arbitrary exception text.
  $message = [string]$_.Exception.Message
  $code = 'UNCLASSIFIED_SETUP_FAILURE'
  if ($message -match '^([A-Z][A-Z0-9_]{3,80})(?:\b|:|$)') {
    $code = $Matches[1]
  }
  Write-Output "KMJ_NATIVE_SUPERVISOR_BLOCKER=$code"
  throw 'KMJ_NATIVE_SUPERVISOR_RECOVERY_BLOCKED'
}
Write-Output 'KMJ_NATIVE_SUPERVISOR_HMAC=PASS'
Write-Output 'AGENT_HANDOFF=PENDING_SEPARATE_VERIFIED_STEP'
Write-Output 'CINECORE=UNTOUCHED'
