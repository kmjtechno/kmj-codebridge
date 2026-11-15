#!/usr/bin/env node
// KMJ TECHNO — select a release ONLY after verifying its exact signed bytes.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseManifest } from "../src/update.js";

const SHA = /^[a-f0-9]{40}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function fail(code) {
  throw Error(code);
}

function validTrust(keys) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    fail("RELEASE_TRUST_KEYS_REQUIRED");
  }
  const entries = Object.entries(keys);
  if (entries.length === 0 || entries.length > 32) {
    fail("RELEASE_TRUST_KEYS_REQUIRED");
  }
  for (const [kid, value] of entries) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(kid) ||
      typeof value !== "string" ||
      value.length < 32 ||
      value.length > 8192 ||
      !value.includes("-----BEGIN PUBLIC KEY-----") ||
      value.includes("PRIVATE KEY")
    ) {
      fail("RELEASE_TRUST_KEYS_INVALID");
    }
  }
  return keys;
}

function sameFile(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function readBounded(file, maxSize) {
  let initial;
  try {
    initial = fs.lstatSync(file);
  } catch {
    fail("RELEASE_METADATA_UNAVAILABLE");
  }
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1 ||
    initial.size < 1 ||
    initial.size > maxSize
  ) {
    fail("RELEASE_METADATA_UNSAFE");
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    if (!sameFile(initial, fs.fstatSync(fd))) {
      fail("RELEASE_METADATA_CHANGED");
    }
    const data = Buffer.alloc(initial.size);
    let pos = 0;
    while (pos < data.length) {
      const n = fs.readSync(fd, data, pos, data.length - pos, pos);
      if (n <= 0) fail("RELEASE_METADATA_CHANGED");
      pos += n;
    }
    if (
      !sameFile(initial, fs.fstatSync(fd)) ||
      !sameFile(initial, fs.lstatSync(file))
    ) {
      fail("RELEASE_METADATA_CHANGED");
    }
    return data;
  } catch (error) {
    if (error?.message?.startsWith("RELEASE_")) throw error;
    fail("RELEASE_METADATA_UNAVAILABLE");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function checkedDirectory(dir) {
  let initial;
  try {
    initial = fs.lstatSync(dir);
  } catch {
    fail("RELEASE_DIRECTORY_UNAVAILABLE");
  }
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    fail("RELEASE_DIRECTORY_UNSAFE");
  }
  // The hosted smoke runs on Linux; Windows test fixtures cannot open
  // directory handles with O_DIRECTORY. Both paths still reject symlinks.
  if (process.platform === "win32") {
    const after = fs.lstatSync(dir);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== initial.dev ||
      after.ino !== initial.ino
    ) {
      fail("RELEASE_DIRECTORY_CHANGED");
    }
    return;
  }
  let fd;
  try {
    fd = fs.openSync(
      dir,
      fs.constants.O_RDONLY |
        (fs.constants.O_DIRECTORY ?? 0) |
        NOFOLLOW,
    );
    const opened = fs.fstatSync(fd);
    if (
      !opened.isDirectory() ||
      initial.dev !== opened.dev ||
      initial.ino !== opened.ino
    ) {
      fail("RELEASE_DIRECTORY_CHANGED");
    }
  } catch (error) {
    if (error?.message?.startsWith("RELEASE_")) throw error;
    fail("RELEASE_DIRECTORY_UNAVAILABLE");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function checkedRoot(root) {
  if (typeof root !== "string" || !root || root.includes("\0")) {
    fail("RELEASE_ROOT_INVALID");
  }
  const target = path.resolve(root);
  const parents = [];
  for (let current = target; ; current = path.dirname(current)) {
    parents.push(current);
    if (current === path.dirname(current)) break;
  }
  for (const candidate of parents.reverse()) checkedDirectory(candidate);
  return target;
}

function hasManifest(dir) {
  try {
    fs.lstatSync(path.join(dir, "release-manifest.json"));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("RELEASE_METADATA_UNAVAILABLE");
  }
}

export function latestSignedRelease(
  root = "releases/stable",
  { trustedKeys, minimumSequence = -1 } = {},
) {
  const keys = validTrust(trustedKeys);
  if (!Number.isSafeInteger(minimumSequence) || minimumSequence < -1) {
    fail("RELEASE_MINIMUM_SEQUENCE_INVALID");
  }
  const stableRoot = checkedRoot(root);
  const names = fs.readdirSync(stableRoot);
  if (names.length > 512) fail("RELEASE_CATALOG_TOO_LARGE");
  const seenSequences = new Set();
  let latest = null;
  for (const revision of names) {
    if (!SHA.test(revision)) continue;
    const directory = path.join(stableRoot, revision);
    checkedDirectory(directory);
    if (!hasManifest(directory)) continue;
    const rawManifest = readBounded(
      path.join(directory, "release-manifest.json"),
      65536,
    );
    const signature = readBounded(
      path.join(directory, "release-manifest.sig"),
      2048,
    ).toString("utf8").trim();
    // Reuse production's Ed25519 raw-byte verifier, never manifest claims.
    const manifest = verifyReleaseManifest(rawManifest, signature, keys);
    if (manifest.revision !== revision) {
      fail("RELEASE_REVISION_DIR_MISMATCH");
    }
    if (manifest.channel !== "stable" || manifest.sequence < 1) {
      fail("RELEASE_STABLE_MANIFEST_INVALID");
    }
    const archiveName =
      "kmj-codebridge-" +
      manifest.version +
      "-" +
      revision.slice(0, 12) +
      ".tar.gz";
    let url;
    try {
      url = new URL(manifest.archive);
    } catch {
      fail("RELEASE_ARCHIVE_URL_INVALID");
    }
    if (
      url.protocol !== "https:" ||
      !url.pathname.endsWith(
        "/codebridge/releases/stable/" + revision + "/" + archiveName,
      )
    ) {
      fail("RELEASE_ARCHIVE_IDENTITY_INVALID");
    }
    if (seenSequences.has(manifest.sequence)) {
      fail("RELEASE_SEQUENCE_DUPLICATE");
    }
    seenSequences.add(manifest.sequence);
    if (!latest || manifest.sequence > latest.sequence) {
      latest = { sequence: manifest.sequence, revision: manifest.revision };
    }
  }
  if (!latest) fail("RELEASE_NONE_FOUND");
  if (latest.sequence <= minimumSequence) {
    fail("RELEASE_ROLLBACK_REJECTED");
  }
  return latest;
}

function trustFromEnvironment() {
  const source = process.env.CODEBRIDGE_RELEASE_TRUSTED_KEYS_JSON;
  if (typeof source !== "string" || !source || source.length > 262144) {
    fail("RELEASE_TRUST_KEYS_REQUIRED");
  }
  try {
    return validTrust(JSON.parse(source));
  } catch (error) {
    if (error?.message?.startsWith("RELEASE_")) throw error;
    fail("RELEASE_TRUST_KEYS_INVALID");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const floor = process.env.CODEBRIDGE_RELEASE_MIN_SEQUENCE;
    const minimumSequence = floor === undefined ? -1 : Number(floor);
    const result = latestSignedRelease(process.argv[2] ?? undefined, {
      trustedKeys: trustFromEnvironment(),
      minimumSequence,
    });
    console.log(
      "LATEST_SIGNED_RELEASE sequence=" +
        result.sequence +
        " revision=" +
        result.revision,
    );
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        "revision=" +
          result.revision +
          "\nsequence=" +
          result.sequence +
          "\n",
      );
    }
  } catch (error) {
    const message = String(error?.message ?? "");
    const code = /^[A-Z][A-Z0-9_]{3,80}$/.test(message)
      ? message
      : "RELEASE_UNVERIFIED";
    console.error("LATEST_SIGNED_RELEASE=FAIL " + code);
    process.exitCode = 1;
  }
}
