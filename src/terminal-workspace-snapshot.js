import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const MAX_FILES = 60;
const MAX_BYTES = 1024 * 1024;

// Internal planning only. The caller supplies a trusted ProjectFiles instance
// rooted in an authorized isolated lane and its local Git HEAD reader.
export function planTerminalWorkspaceSnapshot({
  files,
  readHead,
  expectedHead,
  entries,
}) {
  if (
    typeof readHead !== "function" ||
    typeof files?.read !== "function" ||
    typeof files?.assertCommanderPath !== "function" ||
    typeof expectedHead !== "string" ||
    !GIT_SHA.test(expectedHead)
  )
    throw new Error("TERMINAL_SNAPSHOT_INVALID_CONTEXT");
  if (
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > MAX_FILES
  )
    throw new Error("TERMINAL_SNAPSHOT_INVALID_MANIFEST");

  const aliases = new Set();
  const requested = [];
  for (const entry of entries) {
    if (
      typeof entry?.path !== "string" ||
      entry.path.length > 1024 ||
      !/^[A-Za-z0-9._ /-]+$/.test(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256)
    )
      throw new Error("TERMINAL_SNAPSHOT_INVALID_ENTRY");
    const alias = entry.path.toLowerCase();
    if (aliases.has(alias)) throw new Error("TERMINAL_SNAPSHOT_PATH_COLLISION");
    aliases.add(alias);
    requested.push({ path: entry.path, sha256: entry.sha256 });
  }
  requested.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (readHead() !== expectedHead)
    throw new Error("TERMINAL_SNAPSHOT_HEAD_MISMATCH");
  let bytes = 0;
  const verified = [];
  for (const entry of requested) {
    files.assertCommanderPath(entry.path);
    const file = files.read(entry.path);
    if (
      file.sha256 !== entry.sha256 ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.content !== "string"
    )
      throw new Error("TERMINAL_SNAPSHOT_CONTENT_MISMATCH");
    const encoded = Buffer.from(file.content, "utf8");
    if (
      encoded.length !== file.bytes ||
      createHash("sha256").update(encoded).digest("hex") !== entry.sha256
    )
      throw new Error("TERMINAL_SNAPSHOT_BYTE_ROUNDTRIP_MISMATCH");
    bytes += encoded.length;
    if (bytes > MAX_BYTES) throw new Error("TERMINAL_SNAPSHOT_BYTE_LIMIT");
    verified.push({ ...entry, bytes: encoded.length });
  }
  if (readHead() !== expectedHead)
    throw new Error("TERMINAL_SNAPSHOT_HEAD_MISMATCH");

  const manifest = { version: 1, head: expectedHead, entries: verified, bytes };
  return {
    ...manifest,
    manifestSha256: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    scope: "explicit-selected-files",
    transferred: false,
  };
}
