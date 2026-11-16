# Read-only diagnosis for the P520 Docker Desktop / WSL2 Linux engine.
# No WSL shutdown, unregister, feature activation, Docker reset, or reboot.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::MachineName -ne 'DESKTOP-5FVJMET') {
  throw 'OPENHANDS_ENGINE_DOCTOR_P520_ONLY'
}
Write-Output 'KMJ_OPENHANDS_ENGINE_DOCTOR=READ_ONLY_V1'
Write-Output 'HOST=DESKTOP-5FVJMET'
Write-Output 'DOCKER_OR_WSL_MUTATION=NONE'

function Probe-Native([string]$exe, [string[]]$arguments) {
  try {
    $out = (& $exe @arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $class = 'OTHER'
    if ($out -match 'HCS_E_HYPERV_NOT_INSTALLED|0x80370102|WSL_E_WSL2_NOT_SUPPORTED') {
      $class = 'HYPERV_OR_VMP_UNAVAILABLE'
    } elseif ($out -match 'ERROR_NOT_SUPPORTED|HCS_E_SERVICE_NOT_AVAILABLE|HCS_E_HYPERV_NOT_INSTALLED') {
      $class = 'VIRTUALIZATION_OR_SERVICE_UNAVAILABLE'
    } elseif ($out -match 'access is denied|0x80070005') {
      $class = 'ACCESS_DENIED'
    } elseif ($out -match 'not recognized|not found|Invalid command line option') {
      $class = 'UNSUPPORTED_OR_NOT_INSTALLED'
    } elseif ($code -eq 0) {
      $class = 'PASS'
    }
    return [pscustomobject]@{ Exit = [string]$code; Class = $class }
  } catch {
    return [pscustomobject]@{ Exit = 'ERROR'; Class = 'COMMAND_FAILED' }
  }
}

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  Write-Output ('WINDOWS_BUILD=' + [string]$os.BuildNumber)
  Write-Output ('WINDOWS_VERSION=' + [string]$os.Version)
} catch { Write-Output 'WINDOWS_BUILD=UNKNOWN' }

try {
  $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
  if ($null -ne $cpu) {
    Write-Output ('BIOS_VIRTUALIZATION_ENABLED=' + [string]$cpu.VirtualizationFirmwareEnabled)
    Write-Output ('CPU_SLAT=' + [string]$cpu.SecondLevelAddressTranslationExtensions)
    Write-Output ('CPU_VM_MONITOR_EXTENSIONS=' + [string]$cpu.VMMonitorModeExtensions)
  }
} catch { Write-Output 'CPU_VIRTUALIZATION=UNKNOWN' }

try {
  $machine = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  Write-Output ('HYPERVISOR_PRESENT=' + [string]$machine.HypervisorPresent)
} catch { Write-Output 'HYPERVISOR_PRESENT=UNKNOWN' }

try {
  $features = @(Get-CimInstance Win32_OptionalFeature -ErrorAction Stop |
    Where-Object { $_.Name -in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux', 'Microsoft-Hyper-V-All') })
  foreach ($name in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux', 'Microsoft-Hyper-V-All')) {
    $entry = @($features | Where-Object { $_.Name -eq $name } | Select-Object -First 1)
    $state = if ($entry.Count -eq 1) {
      switch ([int]$entry[0].InstallState) {
        1 { 'ENABLED' }
        2 { 'DISABLED' }
        3 { 'ABSENT' }
        default { 'UNKNOWN' }
      }
    } else { 'NOT_REPORTED' }
    Write-Output ('WINDOWS_FEATURE_' + $name + '=' + $state)
  }
} catch { Write-Output 'WINDOWS_OPTIONAL_FEATURES=UNKNOWN' }

foreach ($name in @('WslService', 'LxssManager', 'vmcompute', 'hns', 'com.docker.service')) {
  try {
    $service = Get-Service -Name $name -ErrorAction Stop
    Write-Output ('SERVICE_' + $name + '=' + [string]$service.Status)
  } catch { Write-Output ('SERVICE_' + $name + '=NOT_AVAILABLE') }
}

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if ($null -eq $wsl) {
  Write-Output 'WSL_COMMAND=NOT_FOUND'
} else {
  foreach ($p in @(
    @{ Label = 'VERSION'; Args = @('--version') },
    @{ Label = 'STATUS'; Args = @('--status') },
    @{ Label = 'DISTRIBUTIONS'; Args = @('--list', '--verbose') }
  )) {
    $result = Probe-Native $wsl.Source $p.Args
    Write-Output ('WSL_' + $p.Label + '_EXIT=' + $result.Exit)
    Write-Output ('WSL_' + $p.Label + '_CLASS=' + $result.Class)
  }
}

$bcd = Get-Command bcdedit.exe -ErrorAction SilentlyContinue
if ($null -ne $bcd) {
  try {
    $lines = (& $bcd.Source /enum '{current}' 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0) {
      if ($lines -match '(?im)^hypervisorlaunchtype\s+Off\s*$') {
        Write-Output 'HYPERVISOR_LAUNCH=OFF'
      } elseif ($lines -match '(?im)^hypervisorlaunchtype\s+Auto\s*$') {
        Write-Output 'HYPERVISOR_LAUNCH=AUTO'
      } else { Write-Output 'HYPERVISOR_LAUNCH=NOT_EXPLICIT' }
    } else { Write-Output 'HYPERVISOR_LAUNCH=UNKNOWN' }
  } catch { Write-Output 'HYPERVISOR_LAUNCH=UNKNOWN' }
}

$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($null -eq $docker) {
  $localCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')
  )
  foreach ($candidate in $localCandidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $docker = [pscustomobject]@{ Source = $candidate }
      break
    }
  }
}
if ($null -eq $docker) {
  Write-Output 'DOCKER_CLI=MISSING'
} else {
  Write-Output 'DOCKER_CLI=FOUND'
  if (-not [string]::IsNullOrWhiteSpace($env:DOCKER_HOST)) {
    Write-Output 'DOCKER_HOST_OVERRIDE=SET_SKIP_PROBE'
  } else {
    $info = Probe-Native $docker.Source @('info', '--format', '{{.OSType}}')
    Write-Output ('DOCKER_ENGINE_EXIT=' + $info.Exit)
    Write-Output ('DOCKER_ENGINE_CLASS=' + $info.Class)
  }
}
Write-Output 'DOCTOR_RESULT=DIAGNOSTIC_ONLY'
Write-Output 'NEXT=REVIEW_FEATURES_VIRTUALIZATION_WSL_AND_DOCKER_DESKTOP_ERRORS'
