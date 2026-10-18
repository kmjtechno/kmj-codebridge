<#
.SYNOPSIS
  Build-only staging check for CodeBridge P720 native Windows service host.
.DESCRIPTION
  Dry-run by default. -Build compiles a fail-closed Stage-0 C# ServiceBase
  host into a NEW temporary directory and runs self-test. It does not
  install/start/register any Windows service or change existing agents.
#>
[CmdletBinding()]
param([switch]$Build, [string]$Destination)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$Source = Join-Path $PSScriptRoot 'native-service\P720AgentService.cs'
$FixtureSource = Join-Path $PSScriptRoot 'native-service\P720ChildLifecycleFixture.cs'
$Compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

Write-Output 'KMJ_P720_SCM_HOST=STAGE_ZERO'
Write-Output 'KMJ_P720_SCM_EXISTING_AGENT_MUTATIONS=NONE'
Write-Output 'KMJ_P720_SCM_EXISTING_TASK_MUTATIONS=NONE'
Write-Output 'KMJ_P720_SCM_CREDENTIALS=UNTOUCHED'
Write-Output 'KMJ_P720_SCM_ACTIVATION=BLOCKED_UNVERIFIED_TAKEOVER'

try {
  if ($env:OS -ne 'Windows_NT') { throw 'SCM_HOST_WINDOWS_ONLY' }
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf) -or
      -not (Test-Path -LiteralPath $FixtureSource -PathType Leaf) -or
      -not (Test-Path -LiteralPath $Compiler -PathType Leaf)) {
    throw 'SCM_HOST_SOURCE_OR_COMPILER_MISSING'
  }
  $sourceInfo = Get-Item -LiteralPath $Source -ErrorAction Stop
  $fixtureInfo = Get-Item -LiteralPath $FixtureSource -ErrorAction Stop
  if (($sourceInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      ($fixtureInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'SCM_HOST_SOURCE_REPARSE_POINT'
  }

  if ($Destination) {
    if (-not [IO.Path]::IsPathRooted($Destination) -or
        -not (Test-Path -LiteralPath $Destination -PathType Container)) {
      throw 'SCM_HOST_DESTINATION_PARENT_REQUIRED'
    }
    $Parent = [IO.Path]::GetFullPath($Destination)
  } else {
    $Parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  }
  $rootResolved = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if ($Parent.StartsWith($rootResolved,[StringComparison]::OrdinalIgnoreCase) -or
      $rootResolved.StartsWith($Parent.TrimEnd('\') + '\',
        [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SCM_HOST_DESTINATION_OVERLAPS_REPOSITORY'
  }
  $OutDir = Join-Path $Parent ('kmj-p720-scm-stage-' + [guid]::NewGuid().ToString('N'))
  if (Test-Path -LiteralPath $OutDir) {
    throw 'SCM_HOST_STAGING_COLLISION'
  }

  if (-not $Build) {
    Write-Output 'KMJ_P720_SCM_HOST_MODE=DRY_RUN'
    Write-Output 'KMJ_P720_SCM_HOST_BUILD=NOT_RUN'
    Write-Output 'KMJ_P720_SCM_HOST_SERVICE_REGISTERED=NO'
    exit 0
  }

  Write-Output 'KMJ_P720_SCM_HOST_MODE=BUILD_ONLY'
  New-Item -ItemType Directory -Path $OutDir -ErrorAction Stop | Out-Null
  $Output = Join-Path $OutDir 'KMJ-P720-AgentService.Stage0.exe'
  $args = @(
    '/nologo',
    '/target:exe',
    '/optimize+',
    ('/out:' + $Output),
    '/reference:System.ServiceProcess.dll',
    $Source,
    $FixtureSource
  )
  $compilerResult = & $Compiler @args
  if ($LASTEXITCODE -ne 0 -or
      -not (Test-Path -LiteralPath $Output -PathType Leaf)) {
    throw 'SCM_HOST_COMPILATION_FAILED'
  }
  $selfTestOutput = & $Output '--self-test'
  if ($LASTEXITCODE -ne 0 -or
      [string]::Join([char]10,[string[]]@($selfTestOutput)) -notmatch
      'KMJ_P720_SERVICE_HOST_AGENT_STARTED=NO') {
    throw 'SCM_HOST_SELFTEST_FAILED'
  }
  $gracefulOutput = & $Output '--lifecycle-self-test'
  $gracefulCode = $LASTEXITCODE
  if ($gracefulCode -ne 0 -or
      [string]::Join([char]10,[string[]]@($gracefulOutput)) -notmatch
      'KMJ_P720_CHILD_LIFECYCLE_GRACEFUL=PASS') {
    # Only fixed numeric status categories, never raw child stderr, paths or
    # credentials from the service context.
    Write-Output "KMJ_P720_SCM_GRACEFUL_EXIT_CLASS=$gracefulCode"
    $failureMarker = [string]::Join(' ',[string[]]@($gracefulOutput))
    if ($failureMarker -match 'KMJ_P720_CHILD_FIXTURE_FAILURE_CLASS=(\d{1,2})') {
      Write-Output "KMJ_P720_SCM_GRACEFUL_FAILURE_CLASS=$($Matches[1])"
    }
    throw 'SCM_HOST_GRACEFUL_FIXTURE_FAILED'
  }
  $timeoutOutput = & $Output '--lifecycle-timeout-self-test'
  $timeoutCode = $LASTEXITCODE
  if ($timeoutCode -ne 0 -or
      [string]::Join([char]10,[string[]]@($timeoutOutput)) -notmatch
      'KMJ_P720_CHILD_LIFECYCLE_TIMEOUT_FENCED=PASS') {
    Write-Output "KMJ_P720_SCM_TIMEOUT_EXIT_CLASS=$timeoutCode"
    $failureMarker = [string]::Join(' ',[string[]]@($timeoutOutput))
    if ($failureMarker -match 'KMJ_P720_CHILD_FIXTURE_FAILURE_CLASS=(\d{1,2})') {
      Write-Output "KMJ_P720_SCM_TIMEOUT_FAILURE_CLASS=$($Matches[1])"
    }
    throw 'SCM_HOST_TIMEOUT_FIXTURE_FAILED'
  }
  Write-Output 'KMJ_P720_SCM_HOST_BUILD=PASS'
  Write-Output 'KMJ_P720_SCM_HOST_GRACEFUL_FIXTURE=PASS'
  Write-Output 'KMJ_P720_SCM_HOST_TIMEOUT_FIXTURE=PASS'
  Write-Output 'KMJ_P720_SCM_HOST_SELFTEST=PASS'
  Write-Output 'KMJ_P720_SCM_HOST_SERVICE_REGISTERED=NO'
  Write-Output 'KMJ_P720_SCM_HOST_SERVICE_STARTED=NO'
  Write-Output 'KMJ_P720_SCM_HOST_PRODUCTION_READY=NO'
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{3,80}$') {
    $code = 'SCM_HOST_BUILD_UNCLASSIFIED'
  }
  Write-Output "KMJ_P720_SCM_HOST_BLOCKER=$code"
  exit 2
}
