# P520-only, guarded WSL Windows feature activation for OpenHands Docker pilot.
# No parameters: read-only status. Explicit -Apply requires elevated PowerShell.
# Never restarts Windows, registers/unregisters distros, edits BCD/BIOS,
# updates WSL, changes Docker resources, or touches CodeBridge services.
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::MachineName -ne 'DESKTOP-5FVJMET') {
  throw 'KMJ_WSL_WRONG_HOST'
}
Write-Output 'KMJ_OPENHANDS_WSL_REPAIR=GUARDED_V1'
Write-Output 'REBOOT_AUTOMATIC=NO'
Write-Output 'DOCKER_AND_EXISTING_WSL_DISTRO_MUTATION=NONE'

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
$build = [int]$os.BuildNumber
if ($build -lt 19045) {
  throw 'KMJ_WSL_UNSUPPORTED_WINDOWS_BUILD'
}
Write-Output ('WINDOWS_BUILD=' + [string]$build)

$featureName = 'Microsoft-Windows-Subsystem-Linux'
$feature = @(Get-CimInstance Win32_OptionalFeature -Filter ("Name='{0}'" -f $featureName) -ErrorAction Stop)
if ($feature.Count -ne 1) {
  throw 'KMJ_WSL_FEATURE_INVENTORY_UNAVAILABLE'
}
$state = [int]$feature[0].InstallState
Write-Output ('WSL_FEATURE_INSTALL_STATE=' + [string]$state)
if ($state -eq 1) {
  Write-Output 'KMJ_WSL_FEATURE=ALREADY_ENABLED'
  Write-Output 'NEXT=VERIFY_WSL_VERSION_THEN_DOCKER_DESKTOP'
  return
}
if ($state -ne 2) {
  throw 'KMJ_WSL_FEATURE_UNEXPECTED_STATE'
}

$vmp = @(Get-CimInstance Win32_OptionalFeature -Filter "Name='VirtualMachinePlatform'" -ErrorAction Stop)
if ($vmp.Count -ne 1 -or [int]$vmp[0].InstallState -ne 1) {
  throw 'KMJ_WSL_VIRTUAL_MACHINE_PLATFORM_NOT_ENABLED'
}
Write-Output 'VIRTUAL_MACHINE_PLATFORM=ENABLED'

if (-not $Apply) {
  Write-Output 'KMJ_WSL_REPAIR=READY_FOR_ADMIN_APPLY'
  Write-Output 'NEXT=RUN_THIS_SCRIPT_ELEVATED_WITH_-Apply'
  return
}

$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'KMJ_WSL_ADMIN_REQUIRED'
}

Write-Output 'KMJ_WSL_REPAIR=ENABLE_FEATURE_ONLY'
$dism = Join-Path $env:SystemRoot 'System32\dism.exe'
if (-not (Test-Path -LiteralPath $dism -PathType Leaf)) {
  throw 'KMJ_WSL_DISM_NOT_FOUND'
}
& $dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
$code = [int]$LASTEXITCODE
Write-Output ('DISM_EXIT_CODE=' + [string]$code)
if ($code -ne 0 -and $code -ne 3010) {
  throw 'KMJ_WSL_FEATURE_ENABLE_FAILED'
}
Write-Output 'KMJ_WSL_FEATURE_ENABLE_COMMAND=PASS'
Write-Output 'KMJ_WSL_REBOOT=OWNER_CONTROLLED_REQUIRED_BEFORE_VERIFICATION'
Write-Output 'NEXT=SAVE_WORK_REBOOT_WINDOWS_THEN_VERIFY_WSL_AND_DOCKER'
