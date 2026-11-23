# KMJ TECHNO — owner-approved original Ed25519 key custody (P520 => Elite only)
# Source-only, review-required helper. Does not sign, enable services or deploy.
# Keep original private key on P520; makes one protected SSH copy to Elite.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$hostIp='150.242.200.81'
$expectedSsh='SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI'
$original=Join-Path $HOME 'kmj-offline-keys\kmj-release.pem'
$public=Join-Path $HOME 'kmj-offline-keys\kmj-release-2026.pub'
$stage='/root/.kmj-codebridge-owner-custody-20261123'
$helperSha='baf8fac584cb4e76819ecabb2032d20f8398cf3b9fa1c06490c9e2396c9d7659'
$helperUri='https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/main/scripts/production/kmj-elite-provision-owner-policy.py'
$work=Join-Path $env:TEMP ('kmj-elite-custody-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -ErrorAction Stop | Out-Null
$kh=Join-Path $work 'known_hosts'
$helper=Join-Path $work 'kmj-elite-provision-owner-policy.py'
try {
  foreach($p in @($original,$public)) {
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw 'ORIGINAL_OWNER_KEY_FILE_MISSING' }
    $f=Get-Item -LiteralPath $p -Force
    if (($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $f.Length -gt 8192 -or $f.Length -lt 1) {
      throw 'ORIGINAL_OWNER_KEY_FILE_UNTRUSTED'
    }
  }
  foreach($command in @('ssh-keyscan.exe','ssh-keygen.exe','ssh.exe','scp.exe')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw 'WINDOWS_OPENSSH_REQUIRED' }
  }
  Invoke-WebRequest -UseBasicParsing -Uri $helperUri -OutFile $helper
  if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $helperSha) {
    throw 'REMOTE_ENROLLMENT_HELPER_PIN_MISMATCH'
  }
  # Windows PowerShell 5.1 turns OpenSSH's harmless stderr version banner
  # into a terminating NativeCommandError under ErrorActionPreference=Stop.
  # Redirect both streams as native files; still require successful exit and
  # a single pinned ED25519 host key below (no trust-on-first-use fallback).
  $scanOut=Join-Path $work 'keyscan.stdout'
  $scanErr=Join-Path $work 'keyscan.stderr'
  # Win32-OpenSSH ssh-keyscan may advertise sntrup KEX it cannot execute.
  # Prefer the Git-for-Windows OpenSSH scanner, never the broken Win32 one.
  # Host identity is still verified against the independent pinned fingerprint.
  $scanCandidates=@()
  $gitExe=Get-Command git.exe -ErrorAction SilentlyContinue
  if ($gitExe) {
    $gitRoot=Split-Path -Parent (Split-Path -Parent $gitExe.Source)
    $scanCandidates+=Join-Path $gitRoot 'usr\bin\ssh-keyscan.exe'
  }
  if ($env:ProgramFiles) {
    $scanCandidates+=Join-Path $env:ProgramFiles 'Git\usr\bin\ssh-keyscan.exe'
  }
  $scanBinary=$null
  foreach($candidate in $scanCandidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $scanMeta=Get-Item -LiteralPath $candidate -Force
      if (($scanMeta.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'GIT_KEYSCAN_SYMLINK_REJECTED'
      }
      $scanBinary=$candidate
      break
    }
  }
  if (-not $scanBinary) { throw 'GIT_FOR_WINDOWS_KEYSCAN_REQUIRED' }
  $scanProc=Start-Process -FilePath $scanBinary `
    -ArgumentList @('-T','8','-t','ed25519',$hostIp) -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $scanOut -RedirectStandardError $scanErr
  if ($scanProc.ExitCode -ne 0) { throw 'ELITE_ED25519_SSH_HOST_ID_UNAVAILABLE' }
  $scan=@(Get-Content -LiteralPath $scanOut -ErrorAction Stop)
  $entries=@($scan | Where-Object { $_ -match '^150\.242\.200\.81 ssh-ed25519 [A-Za-z0-9+/=]+$' })
  if ($entries.Count -ne 1) { throw 'ELITE_ED25519_SSH_HOST_ID_UNAVAILABLE' }
  [IO.File]::WriteAllText($kh,($entries[0]+"`n"),[Text.Encoding]::ASCII)
  $keyprint=& ssh-keygen.exe -l -f $kh -E sha256 2>$null
  if ($LASTEXITCODE -ne 0 -or $keyprint -notmatch [regex]::Escape($expectedSsh)) {
    throw 'ELITE_SSH_HOST_PIN_MISMATCH'
  }
  Write-Host 'ELITE_SSH_HOST_PIN=PASS'
  # Win32-OpenSSH/scp can misparse -o UserKnownHostsFile=H:\IDE BACKUP\...
  # because the Windows TEMP directory contains spaces. A dedicated ASCII
  # config with a quoted forward-slash path is shared by ssh.exe and scp.exe.
  # No new host key is trusted: only the verified per-run known_hosts is used.
  $knownHostsWin=$kh.Replace('\','/')
  if ($knownHostsWin -match '[`"\r\n]') { throw 'SSH_TEMP_PATH_UNSAFE' }
  $sshConfig=Join-Path $work 'ssh_config'
  $sshConfigLines=@(
    ('Host '+$hostIp),
    ('  HostName '+$hostIp),
    '  User root',
    ('  HostKeyAlias '+$hostIp),
    ('  UserKnownHostsFile "'+$knownHostsWin+'"'),
    '  StrictHostKeyChecking yes',
    '  HostKeyAlgorithms ssh-ed25519',
    '  GlobalKnownHostsFile none',
    '  UpdateHostKeys no',
    '  BatchMode no'
  )
  [IO.File]::WriteAllLines($sshConfig,$sshConfigLines,[Text.Encoding]::ASCII)
  $resolvedConfig=@(& ssh.exe -G -F $sshConfig ('root@'+$hostIp) 2>$null)
  if ($LASTEXITCODE -ne 0 -or
      !($resolvedConfig -contains ('userknownhostsfile '+$knownHostsWin)) -or
      !($resolvedConfig -contains 'stricthostkeychecking true') -or
      !($resolvedConfig -contains 'globalknownhostsfile none') -or
      !($resolvedConfig -contains ('hostkeyalias '+$hostIp))) {
    throw 'SSH_KNOWN_HOSTS_CONFIG_NOT_ATTESTED'
  }
  Write-Host 'SSH_PINNED_CONFIG=PASS'
  $opt=@('-F',$sshConfig)
  & ssh.exe @opt ("root@"+$hostIp) ('test ! -e '+$stage+' && umask 077 && mkdir -m 700 '+$stage)
  if ($LASTEXITCODE -ne 0) { throw 'ELITE_PRIVATE_INBOX_NOT_CREATED' }
  & scp.exe @opt -q $original $public $helper ("root@"+$hostIp+':'+$stage+'/')
  if ($LASTEXITCODE -ne 0) { throw 'ELITE_OWNER_KEY_SSH_TRANSFER_FAILED' }
  Write-Host 'OWNER_KEY_TRANSFER=SSH_PINNED_PRIVATE_INBOX'
  & ssh.exe @opt ("root@"+$hostIp) ('chmod 600 '+$stage+'/* && /usr/bin/python3 -I -B '+$stage+'/kmj-elite-provision-owner-policy.py')
  if ($LASTEXITCODE -ne 0) { throw 'ELITE_SIGNER_PROVISIONING_BLOCKED' }
  Write-Host 'CUSTODY_TRANSFER=PASS_INSPECT_ONLY'
  Write-Host 'SIGNING=NOT_STARTED'
  Write-Host 'PRODUCTION_MUTATION=NONE'
} catch {
  Write-Host ('CUSTODY_TRANSFER=BLOCKED '+$_.Exception.Message)
  throw
} finally {
  # Only the GUID-created temporary directory; remove children without prompt.
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
