#!/usr/bin/env node
// Resolve only OWNER-VERIFIED signed stable CodeBridge releases.
// A high-sequence untrusted JSON file must never redefine production trust.
// This resolver does NOT prove the archive is publicly reachable, installed,
// healthy, or permitted for deployment. Trust is supplied by the owner and
// independently pinned to the known release-key SPKI SHA-256 fingerprint.
import {
  constants, closeSync, fstatSync, lstatSync, openSync, readFileSync,
  readdirSync, realpathSync,
} from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BASE64URL_ED25519 = /^[A-Za-z0-9_-]{86}$/;
const OWNER_KEY_ID = "kmj-release-2026";
export const PINNED_OWNER_SPKI_SHA256 =
  "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8";

function fail(code) { throw new Error(code); }

function ownerKey(pem, expectedFingerprint) {
  if (typeof pem !== "string" || !pem.includes("-----BEGIN PUBLIC KEY-----") ||
      typeof expectedFingerprint !== "string" || !HEX64.test(expectedFingerprint)) {
    fail("RELEASE_OWNER_KEY_REQUIRED");
  }
  let key;
  try { key = createPublicKey(pem); }
  catch { fail("RELEASE_OWNER_KEY_UNTRUSTED"); }
  if (key.asymmetricKeyType !== "ed25519") fail("RELEASE_OWNER_KEY_NOT_ED25519");
  const spki = key.export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256").update(spki).digest("hex");
  if (fingerprint !== expectedFingerprint) fail("RELEASE_OWNER_KEY_UNTRUSTED");
  return key;
}

function safeFile(path, maximum) {
  let pre;
  try { pre = lstatSync(path); }
  catch { fail("RELEASE_SIGNED_FILE_MISSING"); }
  if (!pre.isFile() || pre.isSymbolicLink() || pre.nlink !== 1 ||
      (pre.mode & 0o022) !== 0 || pre.size < 1 || pre.size > maximum) {
    fail("RELEASE_SIGNED_FILE_UNTRUSTED");
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== pre.dev || before.ino !== pre.ino ||
        before.size !== pre.size || before.nlink !== 1) {
      fail("RELEASE_SIGNED_FILE_RACE");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (bytes.length !== pre.size || after.dev !== before.dev ||
        after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      fail("RELEASE_SIGNED_FILE_RACE");
    }
    return bytes;
  } catch (error) {
    if (error?.message?.startsWith("RELEASE_")) throw error;
    fail("RELEASE_SIGNED_FILE_UNTRUSTED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function signedManifest(bytes, signature, dirname, key) {
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); }
  catch { fail("RELEASE_MANIFEST_JSON_INVALID"); }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("RELEASE_MANIFEST_SHAPE_INVALID");
  }
  if (manifest.revision !== dirname) fail("RELEASE_REVISION_DIR_MISMATCH");
  if (!Number.isSafeInteger(manifest.sequence) ||
      manifest.sequence < 1 || manifest.sequence > 100000) {
    fail("RELEASE_SEQUENCE_INVALID");
  }
  if (manifest.schema !== 1 || manifest.product !== "KMJ CodeBridge" ||
      manifest.channel !== "stable" || manifest.keyId !== OWNER_KEY_ID ||
      manifest.version !== "0.3.2" || manifest.nodeMajor !== 24 ||
      !HEX64.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1024 ||
      !String(manifest.archive).startsWith(
        "https://kmjtechno.com/codebridge/releases/stable/" + dirname + "/"
      ) ||
      !/^kmj-codebridge-0\.3\.2-[a-f0-9]{12}\.tar\.gz$/.test(
        basename(manifest.archive)
      ) || basename(manifest.archive) !==
      "kmj-codebridge-0.3.2-" + dirname.slice(0,12) + ".tar.gz") {
    fail("RELEASE_MANIFEST_SHAPE_INVALID");
  }
  const text = signature.toString("ascii").trim();
  if (!BASE64URL_ED25519.test(text)) fail("RELEASE_SIGNATURE_SHAPE_INVALID");
  const signatureBytes = Buffer.from(text, "base64url");
  if (signatureBytes.length !== 64 ||
      signatureBytes.toString("base64url") !== text) {
    fail("RELEASE_SIGNATURE_SHAPE_INVALID");
  }
  if (!verify(null, bytes, key, signatureBytes)) {
    fail("RELEASE_SIGNATURE_INVALID");
  }
  return { sequence: manifest.sequence, revision: manifest.revision };
}

export function latestSignedRelease(root = "releases/stable", {
  trustedPublicKeyPem,
  trustedSpkiSha256 = PINNED_OWNER_SPKI_SHA256,
} = {}) {
  // Caller choice of trust key is permitted only for isolated unit fixtures.
  // The CLI below always forces PINNED_OWNER_SPKI_SHA256.
  const key = ownerKey(trustedPublicKeyPem, trustedSpkiSha256);
  const base = resolve(root);
  const rootStat = lstatSync(base);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      (rootStat.mode & 0o022) !== 0) fail("RELEASE_ROOT_UNTRUSTED");
  const actualRoot = realpathSync(base);
  let best = null;
  const sequences = new Set();
  for (const item of readdirSync(base, { withFileTypes: true })) {
    if (!FULL_SHA.test(item.name)) continue;
    if (!item.isDirectory() || item.isSymbolicLink()) {
      fail("RELEASE_DIRECTORY_UNTRUSTED");
    }
    const directory = join(base, item.name);
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        (entry.mode & 0o022) !== 0 ||
        !realpathSync(directory).startsWith(actualRoot + sep)) {
      fail("RELEASE_DIRECTORY_UNTRUSTED");
    }
    const manifestPath = join(directory, "release-manifest.json");
    // A revision folder without a manifest is NOT an eligible signed release.
    // A manifest with missing/invalid signature is fatal, not silently skipped.
    try { lstatSync(manifestPath); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      fail("RELEASE_SIGNED_FILE_UNTRUSTED");
    }
    const bytes = safeFile(manifestPath, 65536);
    const signature = safeFile(join(directory,"release-manifest.sig"), 1024);
    const signed = signedManifest(bytes,signature,item.name,key);
    if (sequences.has(signed.sequence)) fail("RELEASE_SEQUENCE_DUPLICATE");
    sequences.add(signed.sequence);
    if (best === null || signed.sequence > best.sequence) best = signed;
  }
  if (!best) fail("RELEASE_NONE_VERIFIED");
  return best;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // The actual owner public key is not bundled, inferred from manifests or
    // fetched from an untrusted URL. CI must provision an owner-verified public
    // key via the configured GH environment/secret. Missing key FAILS CLOSED.
    const b64 = process.env.KMJ_RELEASE_OWNER_PUBLIC_KEY_B64 ?? "";
    if (!/^[A-Za-z0-9+/=\r\n]{60,8192}$/.test(b64)) {
      fail("RELEASE_OWNER_KEY_REQUIRED");
    }
    const pem = Buffer.from(b64,"base64").toString("utf8");
    const { sequence, revision } = latestSignedRelease(
      process.argv[2] ?? undefined,
      { trustedPublicKeyPem: pem, trustedSpkiSha256: PINNED_OWNER_SPKI_SHA256 },
    );
    console.log("LATEST_SIGNED_RELEASE sequence=" + sequence + " revision=" + revision);
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_OUTPUT,
        "revision=" + revision + "\nsequence=" + sequence + "\n");
    }
  } catch (error) {
    const allowed = new Set([
      "RELEASE_OWNER_KEY_REQUIRED","RELEASE_OWNER_KEY_UNTRUSTED",
      "RELEASE_OWNER_KEY_NOT_ED25519","RELEASE_ROOT_UNTRUSTED",
      "RELEASE_DIRECTORY_UNTRUSTED","RELEASE_SIGNED_FILE_MISSING",
      "RELEASE_SIGNED_FILE_UNTRUSTED","RELEASE_SIGNED_FILE_RACE",
      "RELEASE_MANIFEST_JSON_INVALID","RELEASE_MANIFEST_SHAPE_INVALID",
      "RELEASE_REVISION_DIR_MISMATCH","RELEASE_SEQUENCE_INVALID",
      "RELEASE_SIGNATURE_SHAPE_INVALID","RELEASE_SIGNATURE_INVALID",
      "RELEASE_SEQUENCE_DUPLICATE","RELEASE_NONE_VERIFIED"
    ]);
    const message = allowed.has(error?.message) ? error.message : "RELEASE_CATALOG_UNVERIFIED";
    console.error("LATEST_SIGNED_RELEASE=FAIL " + message);
    process.exitCode = 1;
  }
}
