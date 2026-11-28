<#
.SYNOPSIS
  Prepare the private Windows signed-updater state root. Default: read-only.
  No agent configuration, task, signer, runtime or project files are changed.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirm = '',
  [switch]$CheckAclContract
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$trustedSids = @($adminSid.Value, $systemSid.Value)
$rights = [Security.AccessControl.FileSystemRights]::FullControl
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow

function New-ProtectedAcl {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($adminSid)
  foreach ($sid in @($adminSid, $systemSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid, $rights, $inherit, $propagation, $allow
    )
    $acl.AddAccessRule($rule)
  }
  return $acl
}

function Assert-ProtectedAcl([Security.AccessControl.DirectorySecurity]$Acl) {
  if (-not $Acl.AreAccessRulesProtected -or -not $Acl.AreAccessRulesCanonical) {
    throw 'WINDOWS_UPDATE_STATE_ACL_UNPROTECTED'
  }
  $owner = $Acl.GetOwner([Security.Principal.SecurityIdentifier])
  if ($null -eq $owner -or $owner.Value -notin $trustedSids) {
    throw 'WINDOWS_UPDATE_STATE_OWNER_UNTRUSTED'
  }
  $rules = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { throw 'WINDOWS_UPDATE_STATE_ACL_RULE_COUNT' }
  $seen = @()
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if ($sid -notin $trustedSids -or $sid -in $seen -or $rule.IsInherited -or
        $rule.AccessControlType -ne $allow -or $rule.FileSystemRights -ne $rights -or
        $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne $propagation) {
      throw 'WINDOWS_UPDATE_STATE_ACL_RULE_UNTRUSTED'
    }
    $seen += $sid
  }
}

function Assert-PlainDirectoryChain([IO.DirectoryInfo]$Directory) {
  $cursor = $Directory
  while ($null -ne $cursor) {
    if (-not $cursor.Exists -or
        ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'WINDOWS_UPDATE_STATE_PATH_UNTRUSTED'
    }
    $cursor = $cursor.Parent
  }
}

# In-memory Windows-native test only; no path, files or privilege changes.
if ($CheckAclContract) {
  if ($Apply -or $Confirm) { throw 'WINDOWS_UPDATE_STATE_MODE_CONFLICT' }
  $candidate = New-ProtectedAcl
  Assert-ProtectedAcl $candidate
  $untrusted = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $candidate.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $untrusted, $rights, $inherit, $propagation, $allow
  ))
  $rejected = $false
  try { Assert-ProtectedAcl $candidate } catch { $rejected = $true }
  if (-not $rejected) { throw 'WINDOWS_UPDATE_STATE_ACL_TEST_FAILED' }
  Write-Output 'WINDOWS_UPDATE_STATE_ACL_CONTRACT=PASS'
  return
}

if ($Apply -and $Confirm -cne 'OWNER_APPROVES_PROTECTED_UPDATE_STATE') {
  throw 'WINDOWS_UPDATE_STATE_OWNER_CONFIRMATION_REQUIRED'
}
if (-not $Apply -and $Confirm) { throw 'WINDOWS_UPDATE_STATE_MODE_CONFLICT' }
if (-not [Environment]::Is64BitProcess) { throw 'WINDOWS_UPDATE_STATE_64BIT_REQUIRED' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'WINDOWS_UPDATE_STATE_ADMIN_REQUIRED'
}
$programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
if ($programFiles -notmatch '^[A-Za-z]:\\[^\\]+(?:\\[^\\]+)*$') {
  throw 'WINDOWS_UPDATE_STATE_PROGRAM_FILES_UNTRUSTED'
}
$parent = [IO.DirectoryInfo]::new($programFiles)
Assert-PlainDirectoryChain $parent
$drive = [IO.DriveInfo]::new($parent.Root.FullName)
if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') {
  throw 'WINDOWS_UPDATE_STATE_LOCAL_NTFS_REQUIRED'
}
# Use a fixed, separate machine-level name; never accept a caller path.
$name = 'KMJ-CodeBridge-SignedUpdate'
$root = [IO.Path]::Combine($parent.FullName, $name)
# Enumerate with terminating errors rather than treating access denied as absent.
$matches = @(Get-ChildItem -LiteralPath $parent.FullName -Force |
  Where-Object { $_.Name -ieq $name })
if ($matches.Count -gt 1) { throw 'WINDOWS_UPDATE_STATE_PATH_COLLISION' }
if ($matches.Count -eq 1) {
  if (-not ($matches[0] -is [IO.DirectoryInfo])) { throw 'WINDOWS_UPDATE_STATE_PATH_COLLISION' }
  Assert-PlainDirectoryChain $matches[0]
  Assert-ProtectedAcl (Get-Acl -LiteralPath $root)
  Write-Output 'WINDOWS_UPDATE_STATE_ROOT=EXISTING_PROTECTED'
} elseif (-not $Apply) {
  Write-Output 'WINDOWS_UPDATE_STATE_ROOT=ABSENT_READY_FOR_OWNER_SETUP'
} else {
  # The .NET Framework DirectorySecurity overload applies the DACL at
  # creation. Never create an unprotected directory and repair ACLs later.
  $candidate = New-ProtectedAcl
  Assert-ProtectedAcl $candidate
  [void][IO.Directory]::CreateDirectory($root, $candidate)
  Assert-PlainDirectoryChain ([IO.DirectoryInfo]::new($root))
  Assert-ProtectedAcl (Get-Acl -LiteralPath $root)
  Write-Output 'WINDOWS_UPDATE_STATE_ROOT=CREATED_PROTECTED'
}
Write-Output 'WINDOWS_UPDATE_TASK=NOT_INSTALLED'
Write-Output 'WINDOWS_UPDATE_RUNTIME=NOT_CHANGED'
Write-Output 'WINDOWS_UPDATE_SIGNING=NOT_ATTEMPTED'
Write-Output 'SECRET_OUTPUT=NONE'
