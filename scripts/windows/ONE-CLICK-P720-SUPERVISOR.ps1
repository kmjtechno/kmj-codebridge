<#
.SYNOPSIS
  Prepare and activate KMJ TECHNO's OWN native Windows supervisor once.
.DESCRIPTION
  Operator-approved and elevated one-time bootstrap. Runs the existing
  SHA-pinned isolated preparation, then the separately guarded HMAC activation.
  Never edits/restarts the connected agent, CineCore or dirty checkouts.
  Fail-closed: failure in either stage stops the sequence; activation itself
  disables its scheduled task on failed authenticated health verification.
#>
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$prepare = Join-Path $PSScriptRoot 'bootstrap-p720-supervisor.ps1'
$activate = Join-Path $PSScriptRoot 'activate-p720-supervisor.ps1'
foreach ($script in @($prepare, $activate)) {
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw 'KMJ_NATIVE_SUPERVISOR_TRUSTED_SCRIPT_MISSING'
  }
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

Write-Output 'KMJ_NATIVE_SUPERVISOR=PREPARE'
try {
  & $prepare -Apply
  if (-not $?) { throw 'KMJ_NATIVE_SUPERVISOR_PREPARE_FAILED' }
} catch {
  # Do not attempt activation when immutable preparation was not successful.
  throw 'KMJ_NATIVE_SUPERVISOR_PREPARE_BLOCKED'
}

Write-Output 'KMJ_NATIVE_SUPERVISOR=ACTIVATE'
try {
  & $activate -Apply
  if (-not $?) { throw 'KMJ_NATIVE_SUPERVISOR_ACTIVATE_FAILED' }
} catch {
  # The activation script owns its own guarded stop/disable rollback.
  # Preserve the backup manifest and proposal for operator inspection.
  throw 'KMJ_NATIVE_SUPERVISOR_ACTIVATION_BLOCKED'
}

Write-Output 'KMJ_NATIVE_SUPERVISOR_HMAC=PASS'
Write-Output 'AGENT_HANDOFF=PENDING_SEPARATE_VERIFIED_STEP'
Write-Output 'CINECORE=UNTOUCHED'
