import { createHash } from "node:crypto";
import { fail } from "./errors.js";

// Security contract: run ONE root-owned, hash-pinned, read-only Main Platform
// diagnostic (scripts/operations/diagnose-offsite-backup-unit-20261029.sh in
// kmj-main-platform) and return only a strictly validated, categorical result.
// No caller path/argument/environment, no raw journal, no backup-validity claim.
export const OFFSITE_DIAGNOSTIC_PATH =
  "/usr/local/libexec/kmj-main-platform-diagnose-offsite-backup-unit-20261029.sh";
export const OFFSITE_DIAGNOSTIC_SHA256 =
  "3ac8127f8e66ac4579330ae7671c2a2b31f68f6865c2a7c67e376adb475f6e32";
export const OFFSITE_DIAGNOSTIC_UNIT = "kmj-elite-offsite-backup.service";
export const OFFSITE_DIAGNOSTIC_CONFIRMATION =
  "RUN_FIXED_READONLY_OFFSITE_DIAGNOSTIC";

const MAX_SCRIPT_BYTES = 16384;
const MAX_OUTPUT_BYTES = 4096;
const TOKEN = /^[A-Za-z0-9_.-]{1,40}$/;
const NUMBER = /^[0-9]{0,15}$/;

export const FAILURE_CLASSES = Object.freeze([
  "UNKNOWN_EXIT_255_NEEDS_LOG",
  "SSH_AUTH_KEY_REJECTED",
  "SSH_HOSTKEY",
  "NETWORK_OR_REMOTE_DOWN",
  "DISK_OR_REMOTE_QUOTA",
  "REMOTE_AUTH_TOKEN",
  "MISSING_FILE_OR_TOOL",
  "LOCAL_PERMISSION",
]);

// Exactly these keys, each once, each value matching its validator.
const FIELDS = Object.freeze({
  generated_utc: (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v),
  unit: (v) => v === OFFSITE_DIAGNOSTIC_UNIT,
  load_state: (v) => TOKEN.test(v),
  active_state: (v) => /^[A-Za-z0-9_.-]{1,40}\/[A-Za-z0-9_.-]{1,40}$/.test(v),
  result: (v) => TOKEN.test(v),
  exec_main_status: (v) => /^([0-9]{1,3}|unknown)$/.test(v),
  metadata_paths_exposed: (v) => v === "no",
  disk_root_free_kib: (v) => NUMBER.test(v),
  disk_var_free_kib: (v) => NUMBER.test(v),
  disk_var_free_inodes: (v) => NUMBER.test(v),
  journal_scope: (v) => ["EXACT_INVOCATION", "UNAVAILABLE"].includes(v),
  journal_lines_scanned: (v) => /^[0-9]{1,6}$/.test(v),
  failure_class: (v) => FAILURE_CLASSES.includes(v),
  raw_output_suppressed: (v) => v === "yes",
  recentBackupVerified_claim: (v) =>
    v === "NO_THIS_SCRIPT_PROVES_NOTHING_ABOUT_BACKUP_VALIDITY",
  mutations: (v) => v === "NONE",
});

const REPORTED = Object.freeze([
  "generated_utc",
  "load_state",
  "active_state",
  "result",
  "exec_main_status",
  "journal_scope",
  "journal_lines_scanned",
  "failure_class",
]);

function rootOnlyFile(lstat, file) {
  const s = lstat(file);
  return (
    s.isFile() &&
    !s.isSymbolicLink() &&
    s.uid === 0 &&
    s.nlink === 1 &&
    (s.mode & 0o7022) === 0 && // no group/world write, no setuid/setgid/sticky
    (s.mode & 0o100) !== 0 && // owner-executable
    s.size > 0 &&
    s.size <= MAX_SCRIPT_BYTES
  );
}

function rootOnlyDirectory(lstat, dir) {
  const s = lstat(dir);
  return (
    s.isDirectory() &&
    !s.isSymbolicLink() &&
    s.uid === 0 &&
    (s.mode & 0o022) === 0
  );
}

function scriptHash(readFile) {
  const text = readFile(OFFSITE_DIAGNOSTIC_PATH);
  if (typeof text !== "string") fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY");
  return createHash("sha256").update(text).digest("hex");
}

// Pure and exported for tests: validate the diagnostic's stdout.
export function parseOffsiteDiagnostic(output) {
  if (typeof output !== "string" || output.length > MAX_OUTPUT_BYTES)
    fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_UNSAFE_OUTPUT");
  const lines = output.replace(/\n$/, "").split("\n");
  const got = {};
  for (const line of lines) {
    const i = line.indexOf("=");
    if (i < 1) fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_UNSAFE_OUTPUT");
    const key = line.slice(0, i);
    const value = line.slice(i + 1);
    if (
      !Object.hasOwn(FIELDS, key) ||
      Object.hasOwn(got, key) ||
      !FIELDS[key](value)
    )
      fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_UNSAFE_OUTPUT");
    got[key] = value;
  }
  if (Object.keys(got).length !== Object.keys(FIELDS).length)
    fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_UNSAFE_OUTPUT");
  // A classified cause must come from the exact failed invocation of an exit-255 failure.
  if (
    got.failure_class !== "UNKNOWN_EXIT_255_NEEDS_LOG" &&
    (got.journal_scope !== "EXACT_INVOCATION" ||
      got.exec_main_status !== "255" ||
      got.result !== "exit-code")
  )
    fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_INCONSISTENT");
  return Object.fromEntries(REPORTED.map((key) => [key, got[key]]));
}

export function runOffsiteDiagnostic({ run, lstat, readFile }) {
  try {
    if (
      !rootOnlyDirectory(lstat, "/usr/local/libexec") ||
      !rootOnlyFile(lstat, OFFSITE_DIAGNOSTIC_PATH)
    )
      fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY");
    if (scriptHash(readFile) !== OFFSITE_DIAGNOSTIC_SHA256)
      fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY");
  } catch (error) {
    if (error?.code === "SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY") throw error;
    fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY");
  }
  let output;
  try {
    output = run(OFFSITE_DIAGNOSTIC_PATH, [], {
      timeout: 25000,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      cwd: "/",
    });
  } catch {
    // Never surface stderr or the exit detail of the child.
    fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_FAILED");
  }
  const parsed = parseOffsiteDiagnostic(output);
  // The executed bytes must still be the attested bytes.
  try {
    if (scriptHash(readFile) !== OFFSITE_DIAGNOSTIC_SHA256)
      fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY");
  } catch {
    fail("SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY");
  }
  return parsed;
}
