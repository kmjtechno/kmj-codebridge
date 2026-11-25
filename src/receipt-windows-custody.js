import { spawnSync } from "node:child_process";

// Validate real Windows security identities rather than localized ACL text.
// This helper never changes ACLs or prints the path, SID or command output.
export function privateWindowsReceiptPath(filename, directory = false) {
  if (process.platform !== "win32") return false;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
    $p = $env:KMJ_RECEIPT_PATH
    $item = Get-Item -LiteralPath $p -Force
    $directory = $env:KMJ_RECEIPT_DIRECTORY -eq '1'
    if ($item.PSIsContainer -ne $directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = Get-Acl -LiteralPath $p
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 1 }
    if ($directory -and -not $acl.AreAccessRulesProtected) { exit 1 }
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    $ownerFull = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { exit 1 }
        if ($rule.IdentityReference.Value -eq $sid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) {
            if (-not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) {
                if (-not $directory -or (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit))) {
                    $ownerFull = $true
                }
            }
        }
    }
    if (-not $ownerFull) { exit 1 }
    exit 0
} catch { exit 1 }
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
        KMJ_RECEIPT_PATH: filename,
        KMJ_RECEIPT_DIRECTORY: directory ? "1" : "0",
      },
      timeout: 10000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  return result.status === 0 && !result.error && !result.signal;
}
