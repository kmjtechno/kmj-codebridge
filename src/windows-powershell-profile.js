import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fail } from "./errors.js";

const SHA256 = /^[a-f0-9]{64}$/;
const PART = /^[A-Za-z0-9_.-]{1,100}$/;

// A script is selected by an administrator-authored profile, never by a chat
// argument. Prevent traversal and ADS/UNC/drive syntax even before resolving.
export function validApprovedScriptPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !value.endsWith(".ps1")
  )
    return false;
  const parts = value.split("/");
  return (
    parts.length >= 2 &&
    parts.length <= 12 &&
    parts.every((part) => PART.test(part) && part !== "." && part !== "..")
  );
}

function regularFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail("POWERSHELL_SCRIPT_NOT_FOUND");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    fail("POWERSHELL_UNTRUSTED_FILE");
  return stat;
}

export function verifyApprovedPowerShellScript(cwd, approval) {
  if (
    !approval ||
    !validApprovedScriptPath(approval.path) ||
    !SHA256.test(approval.sha256 ?? "")
  )
    fail("POWERSHELL_PROFILE_INVALID");
  let root;
  try {
    root = fs.realpathSync(cwd);
  } catch {
    fail("POWERSHELL_PROJECT_ROOT_INVALID");
  }
  const rootInfo = fs.lstatSync(cwd);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    fail("POWERSHELL_PROJECT_ROOT_UNSAFE");

  // Validate every component before opening the script. Reject symlinks and
  // Windows reparse points even if their real target appears in the project.
  let cursor = root;
  const parts = approval.path.split("/");
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch {
      fail("POWERSHELL_SCRIPT_NOT_FOUND");
    }
    if (stat.isSymbolicLink()) fail("POWERSHELL_SCRIPT_PATH_UNSAFE");
    if (i < parts.length - 1 && !stat.isDirectory())
      fail("POWERSHELL_SCRIPT_PATH_UNSAFE");
    if (i === parts.length - 1) regularFile(cursor);
  }
  const resolved = fs.realpathSync(cursor);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    fail("POWERSHELL_SCRIPT_PATH_UNSAFE");
  const stat = regularFile(resolved);
  if (stat.size < 1 || stat.size > 65536) fail("POWERSHELL_SCRIPT_SIZE_UNSAFE");
  const bytes = fs.readFileSync(resolved);
  const raw = createHash("sha256").update(bytes).digest("hex");
  if (raw !== approval.sha256) {
    // Git for Windows can check out a committed LF .ps1 with CRLF when
    // core.autocrlf is enabled. Accept ONLY the same UTF-8 script with CRLF
    // normalized back to LF, not different code, whitespace, or encoding.
    const decoded = bytes.toString("utf8");
    const isUtf8 = Buffer.from(decoded, "utf8").equals(bytes);
    const normalized = decoded.replace(/\r\n/g, "\n");
    const canonical = isUtf8 && normalized !== decoded
      ? createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex")
      : null;
    if (canonical !== approval.sha256)
      fail("POWERSHELL_SCRIPT_HASH_MISMATCH");
  }
  return resolved;
}

// No -Command/-EncodedCommand, no shell, no caller-selected executable.
// The local signed-in Windows identity stays responsible for OS permissions.
export function approvedPowerShellInvocation({
  cwd,
  profile,
  variant,
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
}) {
  if (!variant?.powershellScript) return null;
  if (platform !== "win32") fail("POWERSHELL_WINDOWS_ONLY");
  if (
    profile?.command !== "powershell.exe" ||
    !["build", "write"].includes(profile.category)
  )
    fail("POWERSHELL_PROFILE_UNTRUSTED_COMMAND");
  if (!systemRoot || !path.win32.isAbsolute(systemRoot))
    fail("POWERSHELL_SYSTEM_ROOT_INVALID");
  const binary = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let binaryInfo;
  try {
    binaryInfo = fs.lstatSync(binary);
  } catch {
    fail("POWERSHELL_BINARY_NOT_FOUND");
  }
  if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink())
    fail("POWERSHELL_BINARY_UNTRUSTED");
  const script = verifyApprovedPowerShellScript(cwd, variant.powershellScript);
  return {
    command: binary,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "RemoteSigned",
      "-File",
      script,
      ...variant.args,
    ],
  };
}
