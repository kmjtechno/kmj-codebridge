import { createHash } from "node:crypto";
import { fail } from "./errors.js";

// One exact, separately reviewed and privately installed root-owned script.
// This is the reviewed Main Platform PR #890 source SHA, NOT the previous
// exit-255-only diagnostic. Never accept a caller path, unit, argv or env.
export const EXIT3_DIAGNOSTIC_PATH =
  "/usr/local/libexec/kmj-main-platform-diagnose-offsite-exit3-20261117.py";
export const EXIT3_DIAGNOSTIC_SHA256 =
  "efa88c7376f78c8de9c4ea2467157a10041bd60fd686375abf75fd4eb03906e9";
export const EXIT3_DIAGNOSTIC_CONFIRMATION =
  "RUN_FIXED_READONLY_OFFSITE_EXIT3_DIAGNOSTIC";

const MAX_SCRIPT_BYTES = 16384;
const MAX_OUTPUT_BYTES = 2048;
const CLASSES = Object.freeze([
  "LOCAL_BACKUP_OR_SOURCE_MISSING",
  "PINNED_SOURCE_OR_IDENTITY_MISMATCH",
  "LOCAL_CAPACITY_OR_QUOTA",
  "REMOTE_NETWORK_OR_DNS",
  "REMOTE_HOSTKEY_OR_SSH_AUTH",
  "REMOTE_CIPHER_OR_READBACK_MISMATCH",
  "RECIPIENT_OR_ENCRYPTION_INVALID",
  "LOCAL_FILE_PERMISSIONS",
  "MISSING_TOOL_OR_RUNTIME",
  "UNKNOWN_NO_JOURNAL",
  "UNKNOWN_EXIT3_NEEDS_OWNER_REVIEW",
]);
const FIELDS = Object.freeze({
  KMJ_OFFSITE_EXIT3: (v) => v === "READ_ONLY_CLASSIFIED",
  SYSTEMD_EXIT: (v) => v === "3",
  JOURNAL_SCOPE: (v) => v === "EXACT_INVOCATION",
  FAILURE_CLASS: (v) => CLASSES.includes(v),
  RAW_JOURNAL_EXPOSED: (v) => v === "NO",
  BACKUP_REPAIR: (v) => v === "NOT_ATTEMPTED",
  OFFHOST_BACKUP_VERIFIED: (v) => v === "NO",
  PRODUCTION_APPROVAL: (v) => v === "UNCHANGED",
});
function rootOnlyDirectory(lstat, dir) {
  const s = lstat(dir);
  return s.isDirectory() && !s.isSymbolicLink() &&
    s.uid === 0 && (s.mode & 0o7022) === 0;
}
function rootOnlyFile(lstat, path) {
  const s = lstat(path);
  return s.isFile() && !s.isSymbolicLink() && s.uid === 0 &&
    s.nlink === 1 && (s.mode & 0o7022) === 0 &&
    s.size > 0 && s.size <= MAX_SCRIPT_BYTES;
}
function hashScript(readFile) {
  const contents = readFile(EXIT3_DIAGNOSTIC_PATH);
  if (typeof contents !== "string" || Buffer.byteLength(contents) > MAX_SCRIPT_BYTES)
    fail("SUPERVISOR_EXIT3_DIAGNOSTIC_NOT_READY");
  return createHash("sha256").update(contents).digest("hex");
}
export function parseExit3Diagnostic(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_OUTPUT_BYTES)
    fail("SUPERVISOR_EXIT3_DIAGNOSTIC_UNSAFE_OUTPUT");
  const lines = raw.replace(/\n$/, "").split("\n");
  if (lines.length !== Object.keys(FIELDS).length)
    fail("SUPERVISOR_EXIT3_DIAGNOSTIC_UNSAFE_OUTPUT");
  const record = Object.create(null);
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator < 1) fail("SUPERVISOR_EXIT3_DIAGNOSTIC_UNSAFE_OUTPUT");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!Object.hasOwn(FIELDS, key) || Object.hasOwn(record, key) ||
        !FIELDS[key](value))
      fail("SUPERVISOR_EXIT3_DIAGNOSTIC_UNSAFE_OUTPUT");
    record[key] = value;
  }
  return Object.freeze({
    execMainStatus: "3",
    journalScope: "EXACT_INVOCATION",
    failureClass: record.FAILURE_CLASS,
  });
}
export function runExit3Diagnostic({ run, lstat, readFile }) {
  try {
    if (!["/", "/usr", "/usr/local", "/usr/local/libexec"].every(
      (dir) => rootOnlyDirectory(lstat, dir)
    ) || !rootOnlyFile(lstat, EXIT3_DIAGNOSTIC_PATH) ||
      hashScript(readFile) !== EXIT3_DIAGNOSTIC_SHA256)
      fail("SUPERVISOR_EXIT3_DIAGNOSTIC_NOT_READY");
  } catch {
    fail("SUPERVISOR_EXIT3_DIAGNOSTIC_NOT_READY");
  }
  let output;
  try {
    // No mutable Python search path, arbitrary executable or caller arguments.
    output = run("/usr/bin/python3",
      ["-I", "-B", EXIT3_DIAGNOSTIC_PATH, "--inspect"],
      { timeout: 25000, maxBuffer: MAX_OUTPUT_BYTES * 2, cwd: "/" });
  } catch {
    // Never show raw journal, stderr, command line or private paths.
    fail("SUPERVISOR_EXIT3_DIAGNOSTIC_FAILED");
  }
  const diagnostic = parseExit3Diagnostic(output);
  try {
    if (hashScript(readFile) !== EXIT3_DIAGNOSTIC_SHA256)
      fail("SUPERVISOR_EXIT3_DIAGNOSTIC_NOT_READY");
  } catch {
    fail("SUPERVISOR_EXIT3_DIAGNOSTIC_NOT_READY");
  }
  return diagnostic;
}
