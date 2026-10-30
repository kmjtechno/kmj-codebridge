// KMJ TECHNO — offline read-only verification of an owner-signed source bundle.
// Does not sign, publish, download, unpack, deploy, or activate any release.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { verifyReleaseManifest } from "../src/update.js";

const MANIFEST_LIMIT = 65536;
const KEYS_LIMIT = 262144;
const ARCHIVE_LIMIT = 536870912;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ARCHIVE_NAME = /^[A-Za-z0-9._-]+\.tar\.gz$/;

// A checked pathname must still designate the same file after it is opened.
// Compare the opened inode with the pathname both before and after the read;
// O_NOFOLLOW alone does not prevent a regular-file rename/swap race.
function sameFileIdentity(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function assertUnchangedFile(file, initial, opened, limit, errorCode) {
  let byPath;
  try {
    byPath = fs.lstatSync(file);
  } catch {
    throw Error(errorCode);
  }
  if (
    !opened.isFile() ||
    !byPath.isFile() ||
    opened.isSymbolicLink() ||
    byPath.isSymbolicLink() ||
    opened.nlink !== 1 ||
    byPath.nlink !== 1 ||
    opened.size < 1 ||
    opened.size > limit ||
    !sameFileIdentity(initial, opened) ||
    !sameFileIdentity(initial, byPath)
  )
    throw Error(errorCode);
}

function boundedRegularFile(file, limit) {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw Error("BUNDLE_PATH_INVALID");
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw Error("BUNDLE_FILE_UNAVAILABLE");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > limit
  )
    throw Error("BUNDLE_FILE_UNSAFE");
  return stat;
}

function readBounded(file, limit) {
  const initial = boundedRegularFile(file, limit);
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(fd);
    assertUnchangedFile(file, initial, stat, limit, "BUNDLE_FILE_CHANGED");
    const bytes = Buffer.alloc(stat.size);
    let cursor = 0;
    while (cursor < bytes.length) {
      const amount = fs.readSync(
        fd,
        bytes,
        cursor,
        bytes.length - cursor,
        cursor,
      );
      if (amount === 0) throw Error("BUNDLE_FILE_CHANGED");
      cursor += amount;
    }
    assertUnchangedFile(
      file,
      initial,
      fs.fstatSync(fd),
      limit,
      "BUNDLE_FILE_CHANGED",
    );
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseBoundedJson(file, limit) {
  const bytes = readBounded(file, limit);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw Error("BUNDLE_JSON_INVALID");
  }
}

async function hashArchive(file, expectedSize) {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > ARCHIVE_LIMIT
  )
    throw Error("BUNDLE_ARCHIVE_SIZE_INVALID");
  const initial = boundedRegularFile(file, ARCHIVE_LIMIT);
  if (initial.size !== expectedSize)
    throw Error("BUNDLE_ARCHIVE_SIZE_MISMATCH");
  let handle;
  try {
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    assertUnchangedFile(
      file,
      initial,
      before,
      ARCHIVE_LIMIT,
      "BUNDLE_ARCHIVE_CHANGED",
    );
    if (before.size !== expectedSize) throw Error("BUNDLE_ARCHIVE_CHANGED");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > expectedSize) throw Error("BUNDLE_ARCHIVE_SIZE_MISMATCH");
      hash.update(chunk);
    }
    const after = await handle.stat();
    assertUnchangedFile(
      file,
      initial,
      after,
      ARCHIVE_LIMIT,
      "BUNDLE_ARCHIVE_CHANGED",
    );
    if (bytes !== expectedSize) throw Error("BUNDLE_ARCHIVE_CHANGED");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    if (handle) await handle.close();
  }
}

export async function verifySignedReleaseBundle({
  signedManifestPath,
  signaturePath,
  trustedKeysPath,
  runtimeManifestPath,
  archivePath,
  minimumSequence = -1,
  expectedChannel = null,
}) {
  if (!Number.isSafeInteger(minimumSequence) || minimumSequence < -1)
    throw Error("BUNDLE_MINIMUM_SEQUENCE_INVALID");

  if (expectedChannel !== null && !["stable", "beta"].includes(expectedChannel))
    throw Error("BUNDLE_EXPECTED_CHANNEL_INVALID");

  const keys = parseBoundedJson(trustedKeysPath, KEYS_LIMIT);
  if (!keys || typeof keys !== "object" || Array.isArray(keys))
    throw Error("BUNDLE_TRUSTED_KEYS_INVALID");
  for (const value of Object.values(keys)) {
    if (
      typeof value !== "string" ||
      !value.includes("-----BEGIN PUBLIC KEY-----") ||
      value.includes("PRIVATE KEY")
    )
      throw Error("BUNDLE_TRUSTED_KEYS_INVALID");
  }

  const manifestBytes = readBounded(signedManifestPath, MANIFEST_LIMIT);
  const signature = readBounded(signaturePath, 2048).toString("utf8").trim();
  const signed = verifyReleaseManifest(manifestBytes, signature, keys, {
    minimumSequence,
  });
  if (expectedChannel !== null && signed.channel !== expectedChannel)
    throw Error("BUNDLE_CHANNEL_MISMATCH");
  const runtime = parseBoundedJson(runtimeManifestPath, MANIFEST_LIMIT);
  if (
    runtime?.product !== "KMJ CodeBridge" ||
    runtime?.format !== "source-runtime" ||
    runtime?.signed !== false ||
    !SHA.test(runtime?.revision ?? "") ||
    !HASH.test(runtime?.sha256 ?? "") ||
    !ARCHIVE_NAME.test(runtime?.archive ?? "") ||
    runtime.archive !==
      `kmj-codebridge-${runtime.version}-${runtime.revision.slice(0, 12)}.tar.gz` ||
    runtime?.revision !== signed.revision ||
    runtime?.version !== signed.version ||
    runtime?.sha256 !== signed.sha256 ||
    runtime?.bytes !== signed.bytes ||
    new URL(signed.archive).pathname.split("/").at(-1) !== runtime.archive ||
    path.basename(archivePath) !== runtime.archive
  )
    throw Error("BUNDLE_MANIFEST_IDENTITY_MISMATCH");

  const archive = await hashArchive(archivePath, signed.bytes);
  if (archive.sha256 !== signed.sha256)
    throw Error("BUNDLE_ARCHIVE_SHA256_MISMATCH");
  return {
    verdict: "CRYPTOGRAPHICALLY_VERIFIED",
    signatureAlgorithm: "Ed25519",
    archiveAlgorithm: "SHA-256",
    revision: signed.revision,
    version: signed.version,
    channel: signed.channel,
    sequence: signed.sequence,
    archiveSha256: archive.sha256,
    archiveBytes: archive.bytes,
    note: "Local source/archive identity only. No network, CI, runtime health, deployment or owner approval was verified.",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      if (args.length !== 6 && args.length !== 7) throw Error("USAGE");
      const minimumSequence = Number(args[5]);
      const result = await verifySignedReleaseBundle({
        signedManifestPath: args[0],
        signaturePath: args[1],
        trustedKeysPath: args[2],
        runtimeManifestPath: args[3],
        archivePath: args[4],
        minimumSequence,
        expectedChannel: args[6] ?? null,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch {
      console.error("SIGNED_BUNDLE_VERIFICATION_FAILED");
      process.exitCode = 1;
    }
  })();
}
