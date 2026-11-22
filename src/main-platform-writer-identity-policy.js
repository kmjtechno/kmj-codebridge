import { createHash } from "node:crypto";
import { fail } from "./errors.js";

// Root-owned installation of the independently-reviewed Main Platform inspector.
// Pin matches kmj-main-platform squash merge ae5978be9be9bf62e8da18cd97db4f416e7ca574.
// Source lives at scripts/operations/elite_activation_writer_identity_doctor.py.
// No caller chooses executable, script, args, environment, current release or UID.
export const WRITER_IDENTITY_INSPECT_PATH =
  "/usr/local/libexec/kmj-main-platform-activation-writer-identity-inspect.py";
export const WRITER_IDENTITY_INSPECT_SHA256 =
  "1d77f327ac518b39d997c415d9390e0ecdb7d0ae0abc1541f3fc664a789b1d0e";
export const WRITER_IDENTITY_INSPECT_CONFIRMATION =
  "RUN_FIXED_READONLY_WRITER_IDENTITY_INSPECT";

const MAX_SCRIPT_BYTES = 32768;
const MAX_OUTPUT_BYTES = 1024;

function trustedRootDirectory(lstat, path) {
  const s = lstat(path);
  return (
    s.isDirectory() &&
    !s.isSymbolicLink() &&
    s.uid === 0 &&
    (s.mode & 0o7022) === 0
  );
}

function trustedRootScript(lstat) {
  const s = lstat(WRITER_IDENTITY_INSPECT_PATH);
  return (
    s.isFile() &&
    !s.isSymbolicLink() &&
    s.uid === 0 &&
    s.nlink === 1 &&
    (s.mode & 0o7022) === 0 &&
    (s.mode & 0o100) !== 0 &&
    s.size > 0 &&
    s.size <= MAX_SCRIPT_BYTES
  );
}

function pin(readFile) {
  const content = readFile(WRITER_IDENTITY_INSPECT_PATH);
  if (typeof content !== "string" || content.length > MAX_SCRIPT_BYTES)
    fail("SUPERVISOR_WRITER_INSPECT_NOT_READY");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// An output parser is the disclosure boundary. No exception message, host
// path, UID, unrecognized stdout or process name is allowed to cross.
export function parseWriterIdentityInspect(output) {
  if (typeof output !== "string" || output.length > MAX_OUTPUT_BYTES)
    fail("SUPERVISOR_WRITER_INSPECT_UNSAFE_OUTPUT");
  const lines = output.replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length !== 5)
    fail("SUPERVISOR_WRITER_INSPECT_UNSAFE_OUTPUT");
  if (
    lines[0] !==
      "KMJ_ACTIVATION_WRITER_IDENTITY=READY_FOR_OWNER_REVIEW_NOT_INSTALLED" ||
    !/^KMJ_FPM_WORKERS_AT_SNAPSHOT=(?:[1-9][0-9]{0,3})$/.test(lines[1]) ||
    lines[2] !== "ACTIVATION_REQUEST=NOT_CREATED" ||
    lines[3] !== "ROOT_BROKER=NOT_STARTED" ||
    lines[4] !== "PRODUCTION_MUTATION=NONE"
  )
    fail("SUPERVISOR_WRITER_INSPECT_UNSAFE_OUTPUT");
  const workers = Number(lines[1].split("=")[1]);
  if (workers > 1024)
    fail("SUPERVISOR_WRITER_INSPECT_UNSAFE_OUTPUT");
  return {
    status: "READY_FOR_OWNER_REVIEW_NOT_INSTALLED",
    productionPoolWorkers: workers,
    activationRequestCreated: false,
    brokerStarted: false,
    productionMutation: "NONE",
    activationApproved: false,
    productionReleaseVerified: false,
  };
}

export function runWriterIdentityInspect({ run, lstat, readFile }) {
  try {
    if (
      !["/", "/usr", "/usr/local", "/usr/local/libexec"].every((path) =>
        trustedRootDirectory(lstat, path),
      ) ||
      !trustedRootScript(lstat) ||
      pin(readFile) !== WRITER_IDENTITY_INSPECT_SHA256
    )
      fail("SUPERVISOR_WRITER_INSPECT_NOT_READY");
  } catch {
    fail("SUPERVISOR_WRITER_INSPECT_NOT_READY");
  }
  let output;
  try {
    output = run(
      "/usr/bin/python3",
      ["-I", "-B", WRITER_IDENTITY_INSPECT_PATH, "--inspect"],
      { timeout: 25000, maxBuffer: MAX_OUTPUT_BYTES * 2, cwd: "/" },
    );
  } catch {
    // Exit 2 is a legitimate fail-closed inspector result, not a PASS.
    // Never echo stderr/stdout from an unsuccessful privileged process.
    fail("SUPERVISOR_WRITER_INSPECT_BLOCKED");
  }
  const parsed = parseWriterIdentityInspect(output);
  try {
    if (
      !trustedRootScript(lstat) ||
      pin(readFile) !== WRITER_IDENTITY_INSPECT_SHA256
    )
      fail("SUPERVISOR_WRITER_INSPECT_NOT_READY");
  } catch {
    fail("SUPERVISOR_WRITER_INSPECT_NOT_READY");
  }
  return parsed;
}
