import fs from "node:fs";

// This fixed path is selected ONLY for the sole active stage gateway systemd
// unit. It is not inferred from process arguments, environment or a request.
export const STAGE_GATEWAY_CONFIG = "/etc/kmj-codebridge-stage/gateway.json";
const STAGE_GATEWAY_DIR = "/etc/kmj-codebridge-stage";
const MAX_CONFIG_BYTES = 1024 * 1024;

function trustFailure() {
  const error = new Error("Fixed stage gateway config trust check failed");
  error.code = "CONFIG_TRUST_INVALID";
  return error;
}

function trustedDirectory(info, serviceUid) {
  const ownerIsRoot = info.uid === 0;
  const ownerIsService =
    Number.isSafeInteger(serviceUid) &&
    serviceUid > 0 &&
    info.uid === serviceUid;
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    Number.isSafeInteger(info.gid) &&
    info.gid >= 0 &&
    // Retain the existing trusted root-owned directory policy. A dedicated
    // nonroot service-owned directory MUST be 0700-equivalent, with no
    // traversal/read bits for any other account, even its own group.
    ((ownerIsRoot && (info.mode & 0o027) === 0) ||
      (ownerIsService && (info.mode & 0o077) === 0))
  );
}

function trustedFile(info, directory) {
  const ownerIsRoot = directory.uid === 0;
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    // The file must be owned by exactly the same trusted owner as its
    // protected parent. Never allow mixed-root/service ownership.
    info.uid === directory.uid &&
    info.nlink === 1 &&
    Number.isSafeInteger(info.gid) &&
    info.gid >= 0 &&
    Number.isSafeInteger(info.size) &&
    info.size >= 0 &&
    info.size <= MAX_CONFIG_BYTES &&
    (ownerIsRoot
      ? // Preserve the previous root-owned 0600/0640 protection.
        (info.mode & 0o137) === 0 &&
        ((info.mode & 0o040) === 0 || info.gid === directory.gid)
      : // A service-owned credential is accepted ONLY as a fully private
        // non-executable file with the same group as its parent.
        info.gid === directory.gid && (info.mode & 0o177) === 0)
  );
}

// No symlink traversal of the stage directory or final file, no unbounded
// secret reads, no TOCTOU between path metadata and the opened inode.
// The caller only receives schema-validation outcome, never this text.
export function readTrustedStageGatewayConfig({
  io = fs,
  serviceUid = null,
} = {}) {
  const directory = io.lstatSync(STAGE_GATEWAY_DIR);
  if (!trustedDirectory(directory, serviceUid)) {
    throw trustFailure();
  }
  const before = io.lstatSync(STAGE_GATEWAY_CONFIG);
  if (!trustedFile(before, directory)) throw trustFailure();
  const nofollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(nofollow) || nofollow === 0) throw trustFailure();
  const fd = io.openSync(
    STAGE_GATEWAY_CONFIG,
    fs.constants.O_RDONLY | nofollow | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = io.fstatSync(fd);
    if (
      !trustedFile(opened, directory) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw trustFailure();
    }
    const chunks = [];
    let bytes = 0;
    while (bytes <= MAX_CONFIG_BYTES) {
      const chunk = Buffer.allocUnsafe(
        Math.min(8192, MAX_CONFIG_BYTES + 1 - bytes),
      );
      const n = io.readSync(fd, chunk, 0, chunk.length, null);
      if (!Number.isInteger(n) || n < 0 || n > chunk.length) {
        throw trustFailure();
      }
      if (n === 0) break;
      chunks.push(chunk.subarray(0, n));
      bytes += n;
    }
    if (bytes > MAX_CONFIG_BYTES) throw trustFailure();
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    io.closeSync(fd);
  }
}
