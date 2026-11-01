import fs from "node:fs";
import path from "node:path";

// Replay primitive for a FUTURE owner-protected Windows supervisor.
// It does NOT authenticate callers, approve launchers or attest a process.
// Protected storage and a live Windows witness are separate release gates.
const NONCE = /^[a-f0-9]{32}$/;
const MAX_VALIDITY_MS = 300000;
const MAX_PATH_LENGTH = 260;
const RECORD_PREFIX = "KMJ-P520-LLAMACPP-NONCE-V1\n";

function denied(status) {
  return Object.freeze({
    status,
    recorded: false,
    ownerAttested: false,
    mayEnableInference: false,
  });
}

function checkDirectory(directory, io, p) {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > MAX_PATH_LENGTH ||
    directory.includes("\0") ||
    !p.isAbsolute(directory) ||
    p.normalize(directory) !== directory
  )
    return false;

  // Reject symlinks/junctions in path components. This does not verify
  // ACL ownership or prevent a privileged actor from renaming a directory.
  const pieces = [];
  let current = p.resolve(directory);
  for (let i = 0; i < 64; i += 1) {
    pieces.push(current);
    const parent = p.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (pieces.length === 64 && p.dirname(current) !== current) return false;
  try {
    for (const part of pieces) {
      const stat = io.lstatSync(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
  } catch {
    return false;
  }
  return true;
}

// Exclusive file creation arbitrates concurrent processes sharing an existing
// directory. Existing symlinks, partial files and previous claims count as
// consumed. Never delete or overwrite a claim in order to retry approval.
// This module does not create the directory or change any ACLs.
export function consumeP520ApprovalNonce({
  directory,
  nonce,
  issuedAt,
  expiresAt,
  now = Date.now(),
  io = fs,
  p = path,
} = {}) {
  if (typeof nonce !== "string" || !NONCE.test(nonce))
    return denied("OWNER_NONCE_INVALID");
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(now) ||
    issuedAt < 0 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_VALIDITY_MS ||
    now < issuedAt ||
    now >= expiresAt
  )
    return denied("OWNER_NONCE_EXPIRED_OR_INVALID");
  if (!checkDirectory(directory, io, p))
    return denied("OWNER_NONCE_STORAGE_UNTRUSTED");

  const file = p.join(directory, "p520-" + nonce + ".used");
  const constants = io.constants ?? fs.constants;
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = io.openSync(file, flags, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return denied("OWNER_NONCE_REPLAY");
    return denied("OWNER_NONCE_STORAGE_ERROR");
  }
  try {
    io.writeFileSync(fd, RECORD_PREFIX + nonce + "\n", { encoding: "utf8" });
    io.fsyncSync(fd);
  } catch {
    // Keep a partial claim: a failed write must never permit nonce reuse.
    return denied("OWNER_NONCE_STORAGE_ERROR");
  } finally {
    try {
      io.closeSync(fd);
    } catch {
      return denied("OWNER_NONCE_STORAGE_ERROR");
    }
  }

  // An atomic claim is NOT a trusted runtime attestation. It does not
  // authorize local inference, even after a valid owner signature.
  return Object.freeze({
    status: "OWNER_NONCE_RECORDED_SUPERVISOR_REQUIRED",
    recorded: true,
    ownerAttested: false,
    mayEnableInference: false,
  });
}
