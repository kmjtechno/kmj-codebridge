import { gunzipSync } from "node:zlib";
import {
  releaseManifestSchema,
  validateWindowsRuntimeArchiveEntries,
  verifyReleaseArchive,
} from "./update.js";

const BLOCK = 512;
const MAX_EXPANDED = 128 * 1024 * 1024;

function invalid() {
  throw new Error("WINDOWS_UPDATE_ARCHIVE_REJECTED");
}

function ascii(bytes) {
  if (bytes.some((byte) => byte < 32 || byte > 126)) invalid();
  return bytes.toString("ascii");
}

function field(bytes) {
  const end = bytes.indexOf(0);
  if (end === -1) return ascii(bytes);
  if (bytes.subarray(end).some((byte) => byte !== 0)) invalid();
  return ascii(bytes.subarray(0, end));
}

function octal(bytes) {
  const value = bytes.toString("latin1").replace(/[\0 ]+$/, "").trimStart();
  if (!/^[0-7]+$/.test(value)) invalid();
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) invalid();
  return number;
}

function checksum(header) {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (octal(header.subarray(148, 156)) !== sum) invalid();
}

function pax(payload) {
  const result = new Map();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(32, offset);
    if (space === -1 || space - offset > 6) invalid();
    const count = ascii(payload.subarray(offset, space));
    if (!/^[1-9][0-9]*$/.test(count)) invalid();
    const end = offset + Number(count);
    if (end > payload.length || end <= space + 2 || payload[end - 1] !== 10)
      invalid();
    const row = ascii(payload.subarray(space + 1, end - 1));
    const equal = row.indexOf("=");
    if (equal < 1) invalid();
    const key = row.slice(0, equal);
    if (result.has(key)) invalid();
    result.set(key, row.slice(equal + 1));
    offset = end;
  }
  return result;
}

// Parse the exact verified git-archive payload without invoking tar.exe, shell
// commands, or filesystem extraction. A protected Windows installer can later
// materialize these regular files under an independently verified private ACL.
export function inspectWindowsRuntimeArchive(archive, manifest) {
  const verified = releaseManifestSchema.parse(manifest);
  verifyReleaseArchive(archive, verified);
  let raw;
  try {
    raw = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED });
  } catch {
    invalid();
  }
  if (raw.length % BLOCK !== 0) invalid();
  let offset = 0;
  let pendingPath = null;
  let globalSeen = false;
  let ended = false;
  const entries = [];
  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((byte) => byte === 0)) {
      if (
        pendingPath !== null ||
        offset + BLOCK > raw.length ||
        raw.subarray(offset).some((byte) => byte !== 0)
      )
        invalid();
      ended = true;
      break;
    }
    checksum(header);
    if (
      field(header.subarray(257, 263)) !== "ustar" ||
      ascii(header.subarray(263, 265)) !== "00"
    )
      invalid();
    const size = octal(header.subarray(124, 136));
    const rounded = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + rounded > raw.length) invalid();
    const data = raw.subarray(offset, offset + size);
    if (raw.subarray(offset + size, offset + rounded).some((b) => b !== 0))
      invalid();
    offset += rounded;
    const type = header[156];
    if (type === 103 || type === 120) {
      if (pendingPath !== null || size > 8192) invalid();
      const metadata = pax(data);
      if (type === 103) {
        if (
          globalSeen ||
          entries.length !== 0 ||
          metadata.size !== 1 ||
          metadata.get("comment") !== verified.revision
        )
          invalid();
        globalSeen = true;
      } else {
        if (metadata.size !== 1 || !metadata.get("path")) invalid();
        pendingPath = metadata.get("path");
      }
      continue;
    }
    // Only regular files and directories. Never accept links, devices,
    // sparse files or PAX metadata capable of overriding size/type.
    if (type !== 48 && type !== 0 && type !== 53) invalid();
    const name = field(header.subarray(0, 100));
    const prefix = field(header.subarray(345, 500));
    const relative = pendingPath ?? (prefix ? prefix + "/" + name : name);
    pendingPath = null;
    const directory = type === 53;
    if (directory !== relative.endsWith("/") || (directory && size !== 0))
      invalid();
    if (field(header.subarray(157, 257)) !== "") invalid();
    entries.push({ name: relative, directory, data });
    if (entries.length > 10000) invalid();
  }
  if (!ended || !globalSeen) invalid();
  const root = validateWindowsRuntimeArchiveEntries(
    entries.map((entry) => entry.name),
    verified,
  );
  const pkg = entries.find((entry) => entry.name === root + "/package.json");
  const cli = entries.find((entry) => entry.name === root + "/src/cli.js");
  if (!pkg || pkg.directory || !cli || cli.directory || !cli.data.length)
    invalid();
  let identity;
  try {
    identity = JSON.parse(pkg.data.toString("utf8"));
  } catch {
    invalid();
  }
  if (
    identity?.name !== "@kmjtechno/codebridge" ||
    identity?.version !== verified.version
  )
    invalid();
  return {
    root,
    revision: verified.revision,
    sequence: verified.sequence,
    archiveVerified: true,
    activationAttempted: false,
    entries,
  };
}
