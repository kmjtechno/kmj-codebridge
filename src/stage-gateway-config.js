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

function trustedRootDirectory(info) {
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    info.uid === 0 &&
    Number.isSafeInteger(info.gid) &&
    info.gid >= 0 &&
    // The credential directory must never be traversable by other users.
    (info.mode & 0o027) === 0
  );
}

function trustedRootFile(info, directory) {
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.uid === 0 &&
    info.nlink === 1 &&
    // JSON credentials must not be executable, group-writable or accessible
    // to any unrelated local account.
    (info.mode & 0o137) === 0 &&
    Number.isSafeInteger(info.gid) &&
    info.gid >= 0 &&
    // Group-readable secrets are allowed only for the same root-controlled
    // group as the protected parent directory. Runtime group membership
    // still requires a separate owner/root attestation.
    ((info.mode & 0o040) === 0 || info.gid === directory.gid) &&
    Number.isSafeInteger(info.size) &&
    info.size >= 0 &&
    info.size <= MAX_CONFIG_BYTES
  );
}

// No symlink traversal of the stage directory or final file, no unbounded
// secret reads, no TOCTOU between path metadata and the opened inode.
// The caller only receives schema-validation outcome, never this text.
export function readTrustedStageGatewayConfig({ io = fs } = {}) {
  const directory = io.lstatSync(STAGE_GATEWAY_DIR);
  if (!trustedRootDirectory(directory)) {
    throw trustFailure();
  }
  const before = io.lstatSync(STAGE_GATEWAY_CONFIG);
  if (!trustedRootFile(before, directory)) throw trustFailure();
  const nofollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(nofollow) || nofollow === 0) throw trustFailure();
  const fd = io.openSync(
    STAGE_GATEWAY_CONFIG,
    fs.constants.O_RDONLY | nofollow | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = io.fstatSync(fd);
    if (
      !trustedRootFile(opened, directory) ||
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
