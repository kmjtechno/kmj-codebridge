# KMJ TECHNO — one-time interactive OWNER-only signing policy enrollment.
# No private key content is printed, copied, uploaded or signed remotely.
# This script creates ONLY a protected local JSON policy after explicit consent.
[CmdletBinding()]
param([switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ExpectedHost='DESKTOP-5FVJMET'
$Policy=Join-Path $HOME '.config\kmj-codebridge\auto-sign-policy.json'
$SafeName='KMJ_CODEBRIDGE_OWNER_AUTOSIGN'
$Fingerprint='2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8'
function Mark([string]$n,[string]$v){ Write-Output ($n+'='+$v) }
function Need([bool]$ok,[string]$code){ if(-not $ok){ throw $code } }
function PrivateFile([string]$p){
  if(-not (Test-Path -LiteralPath $p -PathType Leaf)){ return $false }
  return (((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function SelectLocalFile([string]$caption) {
  $dialog=New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title=$caption
  $dialog.CheckFileExists=$true
  $dialog.Multiselect=$false
  $dialog.Filter='All local files (*.*)|*.*'
  if($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    throw 'OWNER_FILE_SELECTION_CANCELLED'
  }
  return [IO.Path]::GetFullPath([string]$dialog.FileName)
}
function SecureAcl([string]$path,[string]$owner) {
  $allowed=@($owner,'S-1-5-18','S-1-5-32-544')
  $a=Get-Acl -LiteralPath $path -ErrorAction Stop
  Need $a.AreAccessRulesProtected 'LOCAL_FILE_ACL_INHERITED'
  $found=$false
  foreach($entry in @($a.Access)){
    $sid=$entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    Need ($sid -in $allowed -and [string]$entry.AccessControlType -ceq 'Allow') 'LOCAL_FILE_ACL_UNSAFE'
    if($sid -ceq $owner){ $found=$true }
  }
  Need $found 'LOCAL_FILE_OWNER_ACL_MISSING'
}
function Within([string]$root,[string]$candidate){
  $a=([IO.Path]::GetFullPath($root)).TrimEnd('\').ToLowerInvariant()
  $b=([IO.Path]::GetFullPath($candidate)).ToLowerInvariant()
  return ($b -ceq $a -or $b.StartsWith(($a+'\'),[StringComparison]::Ordinal))
}
if($SelfTest){
  Need (Within 'C:\KMJ\CodeBridge' 'c:\kmj\codebridge\secrets\signer.pem') 'CASEFOLD_PATH_SELFTEST'
  Need (-not (Within 'C:\KMJ\CodeBridge' 'C:\KMJ\CodeBridgeOther\key.pem')) 'BOUNDARY_PATH_SELFTEST'
  Mark 'OWNER_AUTOSIGN_ENROLL_SELFTEST' 'PASS'
  exit 0
}
try {
  Need ($env:OS -ceq 'Windows_NT' -and
    $env:COMPUTERNAME -ieq $ExpectedHost) 'WRONG_OWNER_HOST'
  Need (-not (Test-Path -LiteralPath $Policy)) 'OWNER_POLICY_ALREADY_EXISTS'
  $git=(Get-Command git.exe -ErrorAction Stop).Source
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  $sourceRoot=([string](& $git -C $PSScriptRoot rev-parse --show-toplevel)).Trim()
  Need ($LASTEXITCODE -eq 0 -and [IO.Path]::IsPathRooted($sourceRoot)) 'TRUSTED_SOURCE_ROOT_REQUIRED'
  $origin=([string](& $git -C $sourceRoot remote get-url origin)).Trim()
  Need ($LASTEXITCODE -eq 0 -and $origin -in @(
    'https://github.com/kmjtechno/kmj-codebridge',
    'https://github.com/kmjtechno/kmj-codebridge.git',
    'git@github.com:kmjtechno/kmj-codebridge.git'
  )) 'SOURCE_REMOTE_UNTRUSTED'
  Add-Type -AssemblyName System.Windows.Forms
  $msg='KMJ TECHNO: Activate automatic owner-signed stable-release PR creation on this P520 for 30 days?' + [Environment]::NewLine +
    'Your selected PRIVATE key remains on this computer. The trusted signer may access it hourly while you are logged in.' + [Environment]::NewLine +
    'It will NOT bypass GitHub independent reviews, signature checks or production rollout gates.' + [Environment]::NewLine +
    'Choose YES only if you explicitly authorize this use of your local signing key.'
  $answer=[System.Windows.Forms.MessageBox]::Show(
    $msg,'KMJ TECHNO - owner authorization',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning)
  Need ($answer -eq [System.Windows.Forms.DialogResult]::Yes) 'OWNER_AUTOSIGN_NOT_APPROVED'
  $private=SelectLocalFile 'Select the existing owner PRIVATE Ed25519 key (stays local)'
  $public=SelectLocalFile 'Select the matching owner PUBLIC Ed25519 key'
  Need ((PrivateFile $private) -and (PrivateFile $public)) 'KEY_FILE_UNTRUSTED'
  Need ($private -ine $public) 'KEY_FILES_IDENTICAL'
  Need (-not (Within $sourceRoot $private) -and
    -not (Within $sourceRoot $public)) 'KEY_INSIDE_SOURCE_REFUSED'
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  SecureAcl $private $owner
  SecureAcl $public $owner
  # Crypto check is local-only. Node built-in crypto reads local keys and
  # prints ONLY PASS/FAIL; no keys are passed in arguments or output.
  $program=@'
const fs=require('fs'),c=require('crypto');
try{
 const priv=c.createPrivateKey(fs.readFileSync(process.env.KMJ_SIGN_KEY));
 const pub=c.createPublicKey(fs.readFileSync(process.env.KMJ_SIGN_PUB));
 const a=c.createPublicKey(priv).export({format:'der',type:'spki'});
 const b=pub.export({format:'der',type:'spki'});
 const hash=c.createHash('sha256').update(b).digest('hex');
 if(priv.asymmetricKeyType!=='ed25519'||pub.asymmetricKeyType!=='ed25519'||
    !a.equals(b)||hash!==process.env.KMJ_OWNER_SPKI){process.exit(2)}
 process.stdout.write('OWNER_SIGNER_LOCAL_KEY_PAIR=PASS\n');
}catch{process.exit(2)}
'@
  $oldPrivate=$env:KMJ_SIGN_KEY; $oldPublic=$env:KMJ_SIGN_PUB; $oldPin=$env:KMJ_OWNER_SPKI
  try {
    $env:KMJ_SIGN_KEY=$private
    $env:KMJ_SIGN_PUB=$public
    $env:KMJ_OWNER_SPKI=$Fingerprint
    $result=& $node -e $program 2>$null
    Need ($LASTEXITCODE -eq 0 -and [string]$result -match 'OWNER_SIGNER_LOCAL_KEY_PAIR=PASS') 'OWNER_SIGNER_KEY_PAIR_UNVERIFIED'
  } finally {
    $env:KMJ_SIGN_KEY=$oldPrivate; $env:KMJ_SIGN_PUB=$oldPublic; $env:KMJ_OWNER_SPKI=$oldPin
  }
  $folder=Split-Path -Parent $Policy
  New-Item -ItemType Directory -Path $folder -Force -ErrorAction Stop|Out-Null
  $now=(Get-Date).ToUniversalTime()
  $p=[ordered]@{
    schema=1
    enabled=$true
    repo='kmjtechno/kmj-codebridge'
    profile='owner-host-auto-sign-stable-only'
    ownerConsent='AUTO_SIGN_REVIEWED_MAIN_ONLY'
    keyId='kmj-release-2026'
    approvedAt=$now.ToString('yyyy-MM-ddTHH:mm:ssZ')
    expiresAt=$now.AddDays(30).ToString('yyyy-MM-ddTHH:mm:ssZ')
    maxSequence=256
    repoPath=$sourceRoot
    keyFile=$private
    publicKeyFile=$public
  }
  $json=$p|ConvertTo-Json -Depth 4
  $utf8=New-Object System.Text.UTF8Encoding($false)
  $policyFile=New-Object IO.FileStream($Policy,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {
    $bytes=$utf8.GetBytes($json+[Environment]::NewLine)
    $policyFile.Write($bytes,0,$bytes.Length)
    $policyFile.Flush($true)
  } finally { $policyFile.Dispose() }
  & icacls.exe $Policy /inheritance:r /grant:r ('*'+$owner+':F') '*S-1-5-18:F' '*S-1-5-32-544:F' 1>$null
  Need ($LASTEXITCODE -eq 0) 'OWNER_POLICY_ACL_SET_FAILED'
  SecureAcl $Policy $owner
  Mark 'OWNER_AUTOSIGN_POLICY' 'CREATED_OWNER_ONLY_30_DAYS'
  Mark 'OWNER_AUTOSIGN_PRIVATE_KEY' 'LOCAL_ONLY_UNCOPIED'
  Mark 'OWNER_AUTOSIGN_ENROLL' 'PASS'
} catch {
  $reason=[string]$_.Exception.Message
  if($reason -cnotmatch '^[A-Z][A-Z0-9_]{3,90}$'){$reason='OWNER_ENROLL_REVIEW_REQUIRED'}
  Mark 'OWNER_AUTOSIGN_ENROLL' ('BLOCKED:'+$reason)
  Mark 'OWNER_AUTOSIGN_PRIVATE_KEY' 'NOT_EXPORTED'
  exit 2
}
