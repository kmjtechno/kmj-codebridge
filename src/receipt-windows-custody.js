import { spawnSync } from "node:child_process";

// Validate real Windows security identities rather than localized ACL text.
// This helper never changes ACLs or prints the path, SID or command output.
export function windowsReceiptPathStatus(filename, directory = false) {
  if (process.platform !== "win32") return "NOT_WINDOWS";
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
    $p = $env:KMJ_RECEIPT_PATH
    $attributes = [IO.File]::GetAttributes($p)
    $directory = $env:KMJ_RECEIPT_DIRECTORY -eq '1'
    $isDirectory = [bool]($attributes -band [IO.FileAttributes]::Directory)
    if ($isDirectory -ne $directory -or ($attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 2 }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
    if ($directory) { $acl = [IO.Directory]::GetAccessControl($p, $sections) }
    else { $acl = [IO.File]::GetAccessControl($p, $sections) }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 3 }
    if ($directory -and -not $acl.AreAccessRulesProtected) { exit 4 }
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    $ownerFull = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { exit 5 }
        if ($rule.IdentityReference.Value -eq $sid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) {
            if (-not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) {
                if (-not $directory -or (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit))) {
                    $ownerFull = $true
                }
            }
        }
    }
    if (-not $ownerFull) { exit 6 }
    exit 0
} catch { exit 7 }
`;
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: {
        SystemRoot: "C:\\Windows",
        windir: "C:\\Windows",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32;C:\\Windows",
        PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
        KMJ_RECEIPT_PATH: filename,
        KMJ_RECEIPT_DIRECTORY: directory ? "1" : "0",
      },
      timeout: 30000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  if (result.error?.code === "ETIMEDOUT") return "ACL_CHECK_TIMEOUT";
  if (result.error || result.signal) return "ACL_CHECK_PROCESS_FAILED";
  switch (result.status) {
    case 0:
      return "PRIVATE";
    case 2:
      return "PATH_TYPE_UNSAFE";
    case 3:
      return "OWNER_MISMATCH";
    case 4:
      return "INHERITANCE_UNSAFE";
    case 5:
      return "PRINCIPAL_UNSAFE";
    case 6:
      return "OWNER_RIGHTS_MISSING";
    default:
      return "ACL_CHECK_FAILED";
  }
}

export function privateWindowsReceiptPath(filename, directory = false) {
  return windowsReceiptPathStatus(filename, directory) === "PRIVATE";
}
