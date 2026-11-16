# P520-only, owner-opt-in OpenHands Agent Canvas 1.40.0 Docker pilot.
# Default invocation is read-only. No model, browser or agent starts until -Start.
[CmdletBinding()]
param(
  [switch]$Start,
  [switch]$Status,
  [switch]$Stop,
  [switch]$ReuseWorkspace
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (([int][bool]$Start + [int][bool]$Status + [int][bool]$Stop) -gt 1) {
  throw 'OPENHANDS_ONE_MODE_ONLY'
}
if ($ReuseWorkspace -and -not $Start) {
  throw 'OPENHANDS_REUSE_REQUIRES_START'
}
if ([Environment]::MachineName -ne 'DESKTOP-5FVJMET') {
  throw 'OPENHANDS_WRONG_HOST_P520_ONLY'
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'OPENHANDS_LOCALAPPDATA_MISSING'
}

$image = 'ghcr.io/openhands/agent-canvas:1.40.0'
$container = 'kmj-openhands-canvas-pilot'
$label = 'com.kmjtechno.integration=openhands-pilot'
$volume = 'kmj-openhands-canvas-state'
$root = Join-Path (Join-Path $env:LOCALAPPDATA 'KMJ TECHNO') 'OpenHandsPilot'
$workspace = Join-Path $root 'workspace'

function Assert-NoReparsePoint([string]$p) {
  if (Test-Path -LiteralPath $p) {
    $i = Get-Item -LiteralPath $p -Force
    if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'OPENHANDS_REPARSE_PATH_DENIED'
    }
    if (-not $i.PSIsContainer) {
      throw 'OPENHANDS_WORKSPACE_NOT_DIRECTORY'
    }
  }
}

Assert-NoReparsePoint $root
Assert-NoReparsePoint $workspace
# Docker Desktop per-user installs are not always in the shell PATH.
# Resolve only the exact local executable; never use a remote Docker context.
$docker = Get-Command 'docker.exe' -ErrorAction SilentlyContinue
$dockerExe = $null
if ($null -ne $docker) { $dockerExe = $docker.Source }
$knownLocalDocker = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\resources\bin\docker.exe'),
  (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')
)
if (-not $dockerExe) {
  foreach ($candidate in $knownLocalDocker) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $dockerExe = $candidate
      break
    }
  }
}
if (-not $dockerExe) {
  Write-Output 'OPENHANDS_DOCKER_SETUP=winget install --id Docker.DockerDesktop --exact --source winget'
  Write-Output 'OPENHANDS_DOCKER_NEXT=START_DOCKER_DESKTOP_LINUX_WSL2'
  throw 'OPENHANDS_DOCKER_DESKTOP_MISSING'
}

$context = & $dockerExe context show
if ($LASTEXITCODE -ne 0 -or @($context).Count -ne 1 -or
    ([string]$context).Trim() -ne 'desktop-linux') {
  throw 'OPENHANDS_LOCAL_DOCKER_DESKTOP_CONTEXT_REQUIRED'
}
$osType = & $dockerExe info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0 -or ([string]$osType).Trim() -ne 'linux') {
  throw 'OPENHANDS_LINUX_DOCKER_ENGINE_REQUIRED'
}

$names = @(& $dockerExe ps -a --filter ('name=^/{0}$' -f $container) --format '{{.Names}}')
if ($LASTEXITCODE -ne 0) {
  throw 'OPENHANDS_DOCKER_INVENTORY_FAILED'
}
$exists = $names -contains $container

if ($Status -or $Stop) {
  if (-not $exists) {
    Write-Output 'OPENHANDS_PILOT_CONTAINER=ABSENT'
    return
  }
  $rawLabels = & $dockerExe inspect --format '{{json .Config.Labels}}' $container
  if ($LASTEXITCODE -ne 0) { throw 'OPENHANDS_INSPECT_FAILED' }
  $parsedLabels = ConvertFrom-Json -InputObject ([string]$rawLabels)
  $ownerLabel = $parsedLabels.PSObject.Properties['com.kmjtechno.integration']
  if ($null -eq $ownerLabel -or $ownerLabel.Value -ne 'openhands-pilot') {
    throw 'OPENHANDS_UNOWNED_CONTAINER_DENIED'
  }
  if ($Stop) {
    & $dockerExe stop $container | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'OPENHANDS_STOP_FAILED' }
    Write-Output 'OPENHANDS_PILOT_STOPPED_STATE_VOLUME_PRESERVED'
  } else {
    & $dockerExe ps -a --filter ('name=^/{0}$' -f $container) --format '{{.Names}} {{.Status}} {{.Ports}}'
    if ($LASTEXITCODE -ne 0) { throw 'OPENHANDS_STATUS_FAILED' }
    Write-Output 'OPENHANDS_STATUS_IS_NOT_AUTH_OR_MCP_PROOF'
  }
  return
}

Write-Output ('OPENHANDS_IMAGE=' + $image)
Write-Output ('OPENHANDS_HOST=DESKTOP-5FVJMET')
Write-Output ('OPENHANDS_CANVAS=http://127.0.0.1:8000/canvas')
Write-Output ('OPENHANDS_WORKSPACE=' + $workspace)
Write-Output 'OPENHANDS_PRODUCTION_MUTATION=NONE'
Write-Output 'OPENHANDS_INFERENCE_AND_MCP_AUTH=NOT_VERIFIED'

if (-not $Start) {
  Write-Output 'OPENHANDS_PRECHECK=PASS_START_NOT_REQUESTED'
  return
}
if ($exists) { throw 'OPENHANDS_EXISTING_CONTAINER_REFUSED' }
if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) {
  throw 'OPENHANDS_LOOPBACK_PORT_OCCUPIED'
}

# New files are confined to this dedicated user-local path. Never mount
# a real checkout, C:\, home directory, production .env or Docker socket.
[void][IO.Directory]::CreateDirectory($workspace)
Assert-NoReparsePoint $root
Assert-NoReparsePoint $workspace
$contents = @(Get-ChildItem -LiteralPath $workspace -Force -ErrorAction Stop)
if ($contents.Count -gt 0 -and -not $ReuseWorkspace) {
  throw 'OPENHANDS_NONEMPTY_WORKSPACE_REQUIRES_EXPLICIT_REUSE'
}
if ($ReuseWorkspace) {
  # The owner must separately review data classification. No symlinks,
  # junctions or other Windows reparse points can exist in the mount.
  $all = @(Get-ChildItem -LiteralPath $workspace -Force -Recurse -ErrorAction Stop)
  if (@($all | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  }).Count -gt 0) { throw 'OPENHANDS_NESTED_REPARSE_DENIED' }
}

# Pull is deliberately separate from launch: failure never starts a fallback.
& $dockerExe pull $image
if ($LASTEXITCODE -ne 0) { throw 'OPENHANDS_PINNED_IMAGE_PULL_FAILED' }

# No host Docker socket, root mount, --privileged, public port or credentials.
# Upstream generates its own session API key in the named state volume.
& $dockerExe run -d --rm --name $container `
  --label $label `
  --publish '127.0.0.1:8000:8000' `
  --memory '4g' --cpus '2' --pids-limit '512' `
  --security-opt 'no-new-privileges:true' `
  --mount ('type=volume,source={0},target=/home/openhands/.openhands' -f $volume) `
  --mount ('type=bind,source={0},target=/projects' -f $workspace) `
  $image | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'OPENHANDS_CONTAINER_LAUNCH_FAILED' }

Write-Output 'OPENHANDS_PILOT_CONTAINER_STARTED'
Write-Output 'OPENHANDS_AUTH_AND_AGENT_EXECUTION=NOT_VERIFIED'
Write-Output 'OPENHANDS_CANVAS=http://127.0.0.1:8000/canvas'
Write-Output 'OPENHANDS_KEY_LOCAL_ONLY=docker exec kmj-openhands-canvas-pilot sh -c ''cat "$STATE_DIR/api-key.txt"'''
Write-Output 'OPENHANDS_NEXT=VERIFY_UI_KEY_MCP_OAUTH_FREE_MODEL_AND_ISOLATED_TEST'
