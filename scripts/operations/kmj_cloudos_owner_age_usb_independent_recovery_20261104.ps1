#Requires -Version 5.1
<#
KMJ CloudOS AGE portable recovery: source only, no GCE, ELITE or N2 actions.
Prepare on owner P520; Verify on a DIFFERENT trusted Windows host (not P720).
Uses an existing passphrase-encrypted AGE private-identity USB file. Never exports raw key.
#>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet("Prepare","Verify","SelfTest")][string]$Mode)
$ErrorActionPreference="Stop"
Set-StrictMode -Version Latest
$ExpectedSha="9cfac857eaf977abcb38d26d631c8f24375996c3e0e4c8725f0a410215b1ce70"
$UsbFolder="KMJ-CloudOS-AGE-Recovery"

function Hash-Bytes([byte[]]$b) {
  $s=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($s.ComputeHash($b)).Replace("-","").ToLowerInvariant() }
  finally {$s.Dispose()}
}
function Is-Hex([string]$s,[int]$n) {
  if ($n -eq 32) { return $s -cmatch '^[0-9a-f]{32}$' }
  if ($n -eq 64) { return $s -cmatch '^[0-9a-f]{64}$' }
  return $false
}
function Host-Witness([string]$id) {
  if (-not (Is-Hex $id 32)) {throw "UNTRUSTED_CHALLENGE_ID"}
  $guid=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
  if (-not $guid -or $guid.Length -gt 200) {throw "HOST_IDENTITY_NOT_AVAILABLE"}
  return Hash-Bytes ([Text.Encoding]::UTF8.GetBytes($id + [char]10 + $guid))
}
function Reject-SameHost([string]$old,[string]$current) {
  if (-not (Is-Hex $old 64) -or -not (Is-Hex $current 64)) {throw "HOST_FINGERPRINT_INVALID"}
  if ($old -ceq $current) {throw "SAME_DEVICE_RECOVERY_DENIED"}
}
function Safe-File([string]$p) {
  $f=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if ($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw "UNTRUSTED_FILE"}
  return $f
}
function Usb-Backup-Dir {
  $found=@(
    foreach ($disk in @(Get-Disk | Where-Object {$_.BusType -eq "USB"})) {
      foreach ($part in @(Get-Partition -DiskNumber $disk.Number | Where-Object {$_.DriveLetter})) {
        $letter=[string]$part.DriveLetter
        if ($letter -notmatch '^[A-Z]$') {continue}
        $path=Join-Path ($letter + ":\") $UsbFolder
        if (Test-Path -LiteralPath $path -PathType Container) {
          $f=Get-Item -LiteralPath $path -Force
          if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw "USB_PATH_LINK_DENIED"}
          $path
        }
      }
    }
  )
  if ($found.Count -ne 1) {throw "EXACTLY_ONE_USB_BACKUP_VOLUME_REQUIRED"}
  return [string]$found[0]
}
function Age-Pair {
  $root=Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {throw "OFFICIAL_AGE_NOT_INSTALLED"}
  $pairs=@(
    foreach ($p in @(Get-ChildItem -LiteralPath $root -Directory | Where-Object {$_.Name -like "FiloSottile.age*"})) {
      foreach ($f in @(Get-ChildItem -LiteralPath $p.FullName -File -Recurse -Filter "age.exe")) {
        $kg=Join-Path $f.DirectoryName "age-keygen.exe"
        if (Test-Path -LiteralPath $kg -PathType Leaf) {
          [PSCustomObject]@{Age=$f.FullName;Keygen=$kg}
        }
      }
    }
  )
  if ($pairs.Count -ne 1) {throw "OFFICIAL_AGE_BINARIES_NOT_UNIQUE"}
  $v=(& $pairs[0].Age --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $v -notmatch '1\.3\.2') {throw "AGE_VERSION_NOT_VERIFIED"}
  return $pairs[0]
}
function Usb-Identity([string]$d) {
  $files=@(Get-ChildItem -LiteralPath $d -File -Filter "owner-secure-*.age")
  if ($files.Count -ne 1) {throw "EXACTLY_ONE_ENCRYPTED_USB_IDENTITY_REQUIRED"}
  $f=Safe-File $files[0].FullName
  if ($f.Length -lt 100 -or $f.Length -gt 16384) {throw "USB_IDENTITY_SIZE_INVALID"}
  return $f.FullName
}
function Write-Exclusive([string]$p,[byte[]]$b) {
  $f=[IO.File]::Open($p,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$f.Write($b,0,$b.Length);$f.Flush($true)} finally {$f.Dispose()}
}
function Run-Age([string]$binary,[string[]]$args) {
  $old=$ErrorActionPreference
  try {$ErrorActionPreference="Continue"; & $binary @args; $rc=$LASTEXITCODE}
  finally {$ErrorActionPreference=$old}
  if ($rc -ne 0) {throw "AGE_OPERATION_FAILED"}
}
if ($Mode -eq "SelfTest") {
  if ((Hash-Bytes ([Text.Encoding]::ASCII.GetBytes("abc"))) -cne
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {throw "HASH_SELFTEST_FAILED"}
  if (-not (Is-Hex ("a"*32) 32) -or (Is-Hex "../hello" 32)) {throw "ID_SELFTEST_FAILED"}
  if (-not (Is-Hex ("b"*64) 64) -or (Is-Hex ("z"*64) 64)) {throw "SHA_SELFTEST_FAILED"}
  try {Reject-SameHost ("c"*64) ("c"*64);throw "SELFTEST_FALSE_ALLOW"}
  catch {if ($_.Exception.Message -eq "SELFTEST_FALSE_ALLOW") {throw}}
  Reject-SameHost ("c"*64) ("d"*64)
  "CLOUDOS_OWNER_USB_INDEPENDENT_RECOVERY_OFFLINE_TESTS=PASS"
  "OWNER_INDEPENDENT_DEVICE_RECOVERY=NOT_VERIFIED_SELFTEST_ONLY"
  return
}
$usb=Usb-Backup-Dir
$tools=Age-Pair
$backup=Usb-Identity $usb
if ($Mode -eq "Prepare") {
  if ($env:COMPUTERNAME -ine "DESKTOP-5FVJMET") {throw "ORIGIN_P520_REQUIRED"}
  $local=Join-Path (Join-Path $env:LOCALAPPDATA "KMJ-CloudOS-Owner-AGE") "owner-identity.txt"
  $file=Safe-File $local
  $a=Get-Acl -LiteralPath $local
  if (-not $a.AreAccessRulesProtected) {throw "RAW_OWNER_KEY_DACL_NOT_PROTECTED"}
  $old=$ErrorActionPreference
  try {$ErrorActionPreference="Continue";$lines=@(& $tools.Keygen -y $local 2>$null);$rc=$LASTEXITCODE}
  finally {$ErrorActionPreference=$old}
  if ($rc -ne 0 -or $lines.Count -ne 1) {throw "ORIGINAL_OWNER_KEY_INVALID"}
  $pub=[string]$lines[0]
  if ($pub -cnotmatch '^age1[023456789acdefghjklmnpqrstuvwxyz]{55,90}$') {throw "RECIPIENT_INVALID"}
  if ((Hash-Bytes ([Text.Encoding]::ASCII.GetBytes($pub + [char]10))) -cne $ExpectedSha) {
    throw "PUBLIC_RECIPIENT_SHA256_MISMATCH"
  }
  if (@(Get-ChildItem -LiteralPath $usb -File -Filter "independent-recovery-*.json").Count -gt 0) {
    throw "EXISTING_CHALLENGE_PRESERVE_NO_OVERWRITE"
  }
  $id=[guid]::NewGuid().ToString("N").ToLowerInvariant()
  $src=Join-Path (Split-Path -Parent $local) ($id+".witness")
  $cipher=Join-Path $usb ("independent-recovery-"+$id+".age")
  $manifest=Join-Path $usb ("independent-recovery-"+$id+".json")
  $bytes=New-Object byte[] 64
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try {$rng.GetBytes($bytes)} finally {$rng.Dispose()}
  $success=$false
  try {
    Write-Exclusive $src $bytes
    $plainSha=(Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLowerInvariant()
    Run-Age $tools.Age @("-r",$pub,"-o",$cipher,$src)
    $f=Safe-File $cipher
    if ($f.Length -lt 100 -or $f.Length -gt 16384) {throw "WITNESS_ENCRYPT_SIZE_INVALID"}
    $record=[ordered]@{
      Schema="kmj.cloudos.age.usb-witness.v1"
      ChallengeId=$id
      RecipientSha256=$ExpectedSha
      OriginFingerprint=(Host-Witness $id)
      PlaintextSha256=$plainSha
      CiphertextSha256=(Get-FileHash -LiteralPath $cipher -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $recordBytes=[Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress) + [char]10)
    Write-Exclusive $manifest $recordBytes
    $success=$true
    "P520_USB_INDEPENDENT_CHALLENGE=PREPARED"
    "USB_PRIVATE_IDENTITY=ENCRYPTED_ONLY"
    "OWNER_INDEPENDENT_DEVICE_RECOVERY=NOT_VERIFIED"
    "CLOUDOS_PRODUCTION_RELEASE=BLOCKED"
  } finally {
    Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
    if (-not $success) {Remove-Item -LiteralPath $cipher,$manifest -Force -ErrorAction SilentlyContinue}
  }
  return
}
# Verify: do not allow the P520 or any host with a local raw owner key.
$rawKey=Join-Path (Join-Path $env:LOCALAPPDATA "KMJ-CloudOS-Owner-AGE") "owner-identity.txt"
if (Test-Path -LiteralPath $rawKey) {throw "RAW_OWNER_PRIVATE_KEY_ON_VERIFIER_DENIED"}
$manifests=@(Get-ChildItem -LiteralPath $usb -File -Filter "independent-recovery-*.json")
if ($manifests.Count -ne 1) {throw "EXACTLY_ONE_RECOVERY_CHALLENGE_REQUIRED"}
$mfile=Safe-File $manifests[0].FullName
if ($mfile.Length -lt 200 -or $mfile.Length -gt 2048) {throw "CHALLENGE_MANIFEST_SIZE_INVALID"}
$m=Get-Content -LiteralPath $mfile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if ($m.Schema -cne "kmj.cloudos.age.usb-witness.v1" -or
    -not (Is-Hex ([string]$m.ChallengeId) 32) -or
    $m.RecipientSha256 -cne $ExpectedSha -or
    -not (Is-Hex ([string]$m.OriginFingerprint) 64) -or
    -not (Is-Hex ([string]$m.PlaintextSha256) 64) -or
    -not (Is-Hex ([string]$m.CiphertextSha256) 64)) {throw "CHALLENGE_MANIFEST_INVALID"}
if ($mfile.Name -cne ("independent-recovery-"+$m.ChallengeId+".json")) {throw "CHALLENGE_FILENAME_INVALID"}
Reject-SameHost ([string]$m.OriginFingerprint) (Host-Witness ([string]$m.ChallengeId))
$cipher=Join-Path $usb ("independent-recovery-"+$m.ChallengeId+".age")
[void](Safe-File $cipher)
if ((Get-FileHash -LiteralPath $cipher -Algorithm SHA256).Hash.ToLowerInvariant() -cne $m.CiphertextSha256) {
  throw "USB_WITNESS_CIPHER_HASH_MISMATCH"
}
$out=Join-Path $env:TEMP (([guid]::NewGuid().ToString("N"))+".recovered")
try {
  "SECOND_DEVICE_IDENTITY=DIFFERENT_MACHINE_GUID"
  "Enter owner-chosen USB identity passphrase privately. Never share it in logs."
  Run-Age $tools.Age @("-d","-i",$backup,"-o",$out,$cipher)
  [void](Safe-File $out)
  if ((Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant() -cne $m.PlaintextSha256) {
    throw "USB_INDEPENDENT_RECOVERY_SHA256_MISMATCH"
  }
  "OWNER_SECOND_DEVICE_USB_RECOVERY=PASS_DIFFERENT_MACHINE_GUID"
  "OWNER_SECOND_DEVICE_RECOVERY_SHA256=PASS"
  "RAW_PRIVATE_IDENTITY_IMPORTED=NO"
  "CLOUDOS_PRODUCTION_RELEASE=BLOCKED"
} finally {Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue}
