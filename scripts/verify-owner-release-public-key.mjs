#!/usr/bin/env node
/**
 * KMJ TECHNO — offline release signature evidence checker.
 *
 * A public key taken from the *owner-protected* stable updater config may be
 * supplied in a local PEM file. No private key, network, shell, git command,
 * production service action, configuration edit, or file write is involved.
 *
 * This proves that the supplied key's SPKI fingerprint is the independently
 * documented pin AND that the ten *exact tracked manifest bytes* verify under
 * that key. It cannot establish where a caller-supplied PEM originated.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from "node:crypto";

export const OWNER_KEY_SPKI_SHA256 =
  "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8";

export const REQUIRED_RELEASES = Object.freeze([
  [15, "1d216841f9b2a3aaa80fa42d6a24ab62fd23da2f"],
  [19, "f6be5acc9b87d725f4a7663ee623c30da9e7552d"],
  [20, "8dfb8b569f29b316f6f5186ec6bba6777209be16"],
  [21, "dc14877375a5a87181b23106ac5fe0830856f9b6"],
  [22, "0bf9b3cc0c1ffb7555540ec66f1e26ec517bd624"],
  [23, "37a6627bff6435a29d6b2863a0304db6e41a680b"],
  [24, "dd1ccf3232f9678df6e8e87172c36ff4397c0cac"],
  [25, "55a3f976fd3b71e36b4dcb1864b04d43364418ac"],
  [26, "2e8c4b7ddd2c7471000221c39b4e4bbd7dced8d5"],
  [27, "40655678db7fa62edca28ccc4988614010253ef1"],
]);

const RELEASES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../releases/stable",
);
const MAX_MANIFEST = 65536;
const MAX_SIGNATURE = 1024;
const MAX_PEM = 8192;

function deny(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function requireThat(ok, code) {
  if (!ok) deny(code);
}

function readRegularNoFollow(file, limit) {
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const before = fs.fstatSync(fd);
    requireThat(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1 &&
        before.size > 0 &&
        before.size <= limit,
      "RELEASE_EVIDENCE_FILE_UNTRUSTED",
    );
    const buffer = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    requireThat(
      buffer.length === before.size &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs,
      "RELEASE_EVIDENCE_FILE_CHANGED",
    );
    return buffer;
  } catch (error) {
    if (error?.code?.startsWith?.("RELEASE_")) throw error;
    deny("RELEASE_EVIDENCE_FILE_MISSING");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function ownerPublicKey(pem) {
  requireThat(
    typeof pem === "string" &&
      pem.length < MAX_PEM &&
      pem.startsWith("-----BEGIN PUBLIC KEY-----") &&
      pem.trimEnd().endsWith("-----END PUBLIC KEY-----") &&
      !pem.includes("PRIVATE KEY"),
    "OWNER_PUBLIC_KEY_FORMAT_INVALID",
  );
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    deny("OWNER_PUBLIC_KEY_INVALID");
  }
  requireThat(
    key.type === "public" && key.asymmetricKeyType === "ed25519",
    "OWNER_PUBLIC_KEY_NOT_ED25519",
  );
  const der = key.export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256").update(der).digest("hex");
  return { key, fingerprint };
}

function parseSignature(raw) {
  const text = raw.toString("ascii").trim();
  requireThat(
    /^[A-Za-z0-9_-]{86}$/.test(text),
    "RELEASE_SIGNATURE_ENCODING_INVALID",
  );
  const bytes = Buffer.from(text, "base64url");
  requireThat(
    bytes.length === 64 && bytes.toString("base64url") === text,
    "RELEASE_SIGNATURE_ENCODING_INVALID",
  );
  return bytes;
}

function parseManifest(raw, sequence, revision) {
  let item;
  try {
    item = JSON.parse(raw.toString("utf8"));
  } catch {
    deny("RELEASE_MANIFEST_JSON_INVALID");
  }
  requireThat(
    item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      item.schema === 1 &&
      item.product === "KMJ CodeBridge" &&
      item.channel === "stable" &&
      item.sequence === sequence &&
      item.revision === revision &&
      item.version === "0.3.2" &&
      item.keyId === "kmj-release-2026" &&
      item.nodeMajor === 24 &&
      typeof item.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(item.sha256) &&
      Number.isSafeInteger(item.bytes) &&
      item.bytes > 0 &&
      item.archive ===
        "https://kmjtechno.com/codebridge/releases/stable/" +
          revision +
          "/kmj-codebridge-0.3.2-" +
          revision.slice(0, 12) +
          ".tar.gz",
    "RELEASE_MANIFEST_IDENTITY_INVALID",
  );
}

export function verifyAllReleaseSignatures({
  publicKeyPem,
  releasesRoot = RELEASES_ROOT,
  expectedFingerprint = OWNER_KEY_SPKI_SHA256,
  releases = REQUIRED_RELEASES,
}) {
  requireThat(
    Array.isArray(releases) &&
      releases.length === 10 &&
      releases.every(
        (v) =>
          Array.isArray(v) &&
          v.length === 2 &&
          Number.isSafeInteger(v[0]) &&
          /^[a-f0-9]{40}$/.test(v[1]),
      ),
    "RELEASE_SET_INVALID",
  );
  const { key, fingerprint } = ownerPublicKey(publicKeyPem);
  requireThat(
    fingerprint === expectedFingerprint,
    "OWNER_PUBLIC_KEY_FINGERPRINT_MISMATCH",
  );
  const root = fs.realpathSync(releasesRoot);
  let count = 0;
  for (const [sequence, revision] of releases) {
    const dir = path.join(root, revision);
    const stat = fs.lstatSync(dir);
    requireThat(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "RELEASE_DIRECTORY_UNTRUSTED",
    );
    const raw = readRegularNoFollow(
      path.join(dir, "release-manifest.json"),
      MAX_MANIFEST,
    );
    const sig = parseSignature(
      readRegularNoFollow(
        path.join(dir, "release-manifest.sig"),
        MAX_SIGNATURE,
      ),
    );
    parseManifest(raw, sequence, revision);
    requireThat(
      cryptoVerify(null, raw, key, sig),
      "RELEASE_SIGNATURE_VERIFICATION_FAILED",
    );
    count++;
  }
  return Object.freeze({
    fingerprint,
    passed: count,
    required: releases.length,
  });
}

function main(args) {
  requireThat(
    args.length === 2 &&
      args[0] === "--public-key-file" &&
      typeof args[1] === "string" &&
      args[1].length > 0 &&
      !args[1].startsWith("-"),
    "OWNER_EVIDENCE_USAGE",
  );
  const pem = readRegularNoFollow(path.resolve(args[1]), MAX_PEM).toString(
    "utf8",
  );
  const result = verifyAllReleaseSignatures({ publicKeyPem: pem });
  console.log("OWNER_PUBLIC_SPKI_SHA256=" + result.fingerprint);
  console.log(
    "RELEASE_SIGNATURES_VERIFIED=" + result.passed + "/" + result.required,
  );
  console.log("OWNER_RELEASE_KEY_CUSTODY=REQUIRES_ROOT_CONFIG_SOURCE_PROOF");
  console.log("RELEASE_SOURCE_MUTATIONS=NONE");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const safe = /^[A-Z0-9_]+$/.test(error?.code ?? "")
      ? error.code
      : "OWNER_PUBLIC_EVIDENCE_UNVERIFIED";
    console.log("RELEASE_SIGNATURES_VERIFIED=BLOCKED:" + safe);
    process.exitCode = 2;
  }
}
