// Deterministic, bounded SHA-256 receipts for build/test output files.
//
// SOURCE-ONLY: nothing in the gateway, agent or job runner calls this yet. It is
// the reviewed building block for the "artifact SHA-256 receipts" gap of M1 in
// docs/COMMAND-PROFILE-SCHEMA.md. See docs/ARTIFACT-RECEIPTS.md.
//
// Deny by default: the caller names a closed list of relative files or
// directories under one root; everything else is refused, never skipped.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const ARTIFACT_RECEIPT_VERSION = 1;

// Hard ceilings. A caller may ask for less, never for more.
export const ARTIFACT_RECEIPT_LIMITS = Object.freeze({
  maxIncludes: 64,
  maxFiles: 2000,
  maxFileBytes: 1024 ** 3,
  maxTotalBytes: 4 * 1024 ** 3,
  maxDepth: 12,
  maxPathLength: 260,
});

export class ArtifactReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = "ArtifactReceiptError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new ArtifactReceiptError(code);
};

function effectiveLimits(requested = {}) {
  const out = { ...ARTIFACT_RECEIPT_LIMITS };
  for (const key of Object.keys(out)) {
    const value = requested[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1)
      fail("ARTIFACT_LIMIT_INVALID");
    out[key] = Math.min(value, ARTIFACT_RECEIPT_LIMITS[key]);
  }
  return out;
}

// One path segment: portable on Windows and POSIX, no control characters, no
// drive/stream colon, no wildcard, no trailing dot or space.
function validSegment(segment) {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !/[\u0000-\u001f\u007f:*?"<>|\\/]/.test(segment) &&
    !/[. ]$/.test(segment)
  );
}

function normaliseRelative(entry, limits) {
  if (
    typeof entry !== "string" ||
    entry.length === 0 ||
    entry.length > limits.maxPathLength
  )
    fail("ARTIFACT_PATH_INVALID");
  const unified = entry.replaceAll("\\", "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified))
    fail("ARTIFACT_PATH_INVALID");
  const parts = unified.split("/");
  if (parts.length > limits.maxDepth) fail("ARTIFACT_TOO_DEEP");
  if (!parts.every(validSegment)) fail("ARTIFACT_PATH_INVALID");
  return parts.join("/");
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function collect(rootReal, rel, files, state, limits) {
  const absolute = path.join(rootReal, ...rel.split("/"));
  let info;
  try {
    info = await fsp.lstat(absolute);
  } catch {
    return fail("ARTIFACT_NOT_FOUND");
  }
  if (info.isSymbolicLink()) fail("ARTIFACT_SYMLINK_REFUSED");
  // Catches a symlinked or junctioned parent component as well.
  let real;
  try {
    real = await fsp.realpath(absolute);
  } catch {
    return fail("ARTIFACT_NOT_FOUND");
  }
  if (real !== absolute && !real.startsWith(rootReal + path.sep))
    fail("ARTIFACT_OUTSIDE_ROOT");
  if (real !== absolute) fail("ARTIFACT_SYMLINK_REFUSED");
  if (info.isDirectory()) {
    const names = (await fsp.readdir(absolute)).sort(compare);
    for (const name of names) {
      if (!validSegment(name)) fail("ARTIFACT_PATH_INVALID");
      const child = `${rel}/${name}`;
      if (child.length > limits.maxPathLength) fail("ARTIFACT_PATH_INVALID");
      if (child.split("/").length > limits.maxDepth) fail("ARTIFACT_TOO_DEEP");
      await collect(rootReal, child, files, state, limits);
    }
    return;
  }
  if (!info.isFile()) return fail("ARTIFACT_NOT_REGULAR");
  if (files.has(rel)) return;
  if (files.size + 1 > limits.maxFiles) fail("ARTIFACT_TOO_MANY_FILES");
  if (info.size > limits.maxFileBytes) fail("ARTIFACT_FILE_TOO_LARGE");
  state.total += info.size;
  if (state.total > limits.maxTotalBytes) fail("ARTIFACT_TOTAL_TOO_LARGE");
  files.set(rel, { absolute, size: info.size, dev: info.dev, ino: info.ino });
}

async function hashFile(entry) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fsp.open(entry.absolute, flags);
  } catch {
    return fail("ARTIFACT_UNREADABLE");
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== entry.size ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino
    )
      fail("ARTIFACT_CHANGED_WHILE_HASHING");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let seen = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      seen += bytesRead;
      if (seen > entry.size) fail("ARTIFACT_CHANGED_WHILE_HASHING");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (seen !== entry.size) fail("ARTIFACT_CHANGED_WHILE_HASHING");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

const bodyHash = (body) =>
  createHash("sha256").update(JSON.stringify(body)).digest("hex");

export async function buildArtifactReceipt({ root, include, limits } = {}) {
  const max = effectiveLimits(limits);
  if (typeof root !== "string" || !path.isAbsolute(root))
    fail("ARTIFACT_ROOT_INVALID");
  if (!Array.isArray(include) || include.length === 0)
    fail("ARTIFACT_INCLUDE_REQUIRED");
  if (include.length > max.maxIncludes) fail("ARTIFACT_INCLUDE_TOO_LONG");

  let rootInfo;
  try {
    rootInfo = await fsp.lstat(root);
  } catch {
    return fail("ARTIFACT_ROOT_INVALID");
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    fail("ARTIFACT_ROOT_INVALID");
  const rootReal = await fsp.realpath(root);

  const normalised = [
    ...new Set(include.map((entry) => normaliseRelative(entry, max))),
  ].sort(compare);
  const files = new Map();
  const state = { total: 0 };
  for (const rel of normalised) await collect(rootReal, rel, files, state, max);
  if (files.size === 0) fail("ARTIFACT_EMPTY");

  const entries = [];
  for (const rel of [...files.keys()].sort(compare)) {
    const entry = files.get(rel);
    entries.push({
      path: rel,
      size: entry.size,
      sha256: await hashFile(entry),
    });
  }
  const body = {
    version: ARTIFACT_RECEIPT_VERSION,
    algorithm: "sha256",
    include: normalised,
    files: entries,
  };
  return {
    ...body,
    totalFiles: entries.length,
    totalBytes: state.total,
    receiptSha256: bodyHash(body),
  };
}

// Re-hashes exactly what the receipt names (and anything new under the same
// include list) and reports differences. Never throws for a mismatch.
export async function verifyArtifactReceipt(receipt, { root, limits } = {}) {
  const hex = /^[a-f0-9]{64}$/;
  if (
    !receipt ||
    receipt.version !== ARTIFACT_RECEIPT_VERSION ||
    receipt.algorithm !== "sha256" ||
    !Array.isArray(receipt.include) ||
    !Array.isArray(receipt.files) ||
    typeof receipt.receiptSha256 !== "string" ||
    !hex.test(receipt.receiptSha256) ||
    !receipt.files.every(
      (f) =>
        f &&
        typeof f.path === "string" &&
        Number.isSafeInteger(f.size) &&
        hex.test(f.sha256 ?? ""),
    )
  )
    return { ok: false, reason: "RECEIPT_MALFORMED" };
  const claimed = bodyHash({
    version: receipt.version,
    algorithm: receipt.algorithm,
    include: receipt.include,
    files: receipt.files,
  });
  if (claimed !== receipt.receiptSha256)
    return { ok: false, reason: "RECEIPT_SELF_HASH_MISMATCH" };

  let fresh;
  try {
    fresh = await buildArtifactReceipt({
      root,
      include: receipt.include,
      limits,
    });
  } catch (error) {
    if (error instanceof ArtifactReceiptError)
      return { ok: false, reason: error.code };
    throw error;
  }
  const before = new Map(receipt.files.map((f) => [f.path, f]));
  const after = new Map(fresh.files.map((f) => [f.path, f]));
  const modified = [];
  const missing = [];
  const added = [];
  for (const [file, entry] of before) {
    const now = after.get(file);
    if (!now) missing.push(file);
    else if (now.sha256 !== entry.sha256 || now.size !== entry.size)
      modified.push(file);
  }
  for (const file of after.keys()) if (!before.has(file)) added.push(file);
  const ok = fresh.receiptSha256 === receipt.receiptSha256;
  return {
    ok,
    reason: ok ? null : "ARTIFACT_MISMATCH",
    modified,
    missing,
    added,
  };
}
