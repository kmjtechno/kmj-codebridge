import { createHash, createPublicKey, verify } from "node:crypto";
import { TextDecoder } from "node:util";
import { fail } from "./errors.js";

const MANIFEST_KEYS = [
  "archiveBytes",
  "archiveSha256",
  "archiveUrl",
  "channel",
  "format",
  "nodeMajor",
  "product",
  "revision",
  "sequence",
  "v",
  "version",
].sort();
const SIGNATURE_KEYS = ["alg", "kid", "sig", "v"].sort();
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const KID = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_MANIFEST_BYTES = 32768;
const MAX_SIGNATURE_BYTES = 4096;
const MAX_ARCHIVE_BYTES = 536870912;

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail(code);
}

function decodeUtf8(input, maxBytes, code) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (bytes.length < 2 || bytes.length > maxBytes) fail(code);
  try {
    return {
      bytes,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    fail(code);
  }
}

function isUnsafeLiteralHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function validateArchiveUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("UPDATE_MANIFEST_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname ||
    isUnsafeLiteralHost(url.hostname) ||
    !url.pathname.endsWith(".tar.gz")
  )
    fail("UPDATE_MANIFEST_INVALID");
  return url.href;
}

export function parseUpdateManifest(input) {
  const { bytes, text } = decodeUtf8(
    input,
    MAX_MANIFEST_BYTES,
    "UPDATE_MANIFEST_INVALID",
  );
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    fail("UPDATE_MANIFEST_INVALID");
  }
  exactKeys(manifest, MANIFEST_KEYS, "UPDATE_MANIFEST_INVALID");
  if (
    manifest.v !== 1 ||
    manifest.product !== "KMJ_CODEBRIDGE" ||
    !["stable", "beta"].includes(manifest.channel) ||
    !Number.isSafeInteger(manifest.sequence) ||
    manifest.sequence < 0 ||
    typeof manifest.version !== "string" ||
    !SEMVER.test(manifest.version) ||
    typeof manifest.revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.revision) ||
    manifest.format !== "source-runtime" ||
    manifest.nodeMajor !== 24 ||
    typeof manifest.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) ||
    !Number.isSafeInteger(manifest.archiveBytes) ||
    manifest.archiveBytes < 1 ||
    manifest.archiveBytes > MAX_ARCHIVE_BYTES
  )
    fail("UPDATE_MANIFEST_INVALID");

  const archiveUrl = validateArchiveUrl(manifest.archiveUrl);
  return { bytes, manifest: { ...manifest, archiveUrl } };
}

function parseSignature(input) {
  const { text } = decodeUtf8(
    input,
    MAX_SIGNATURE_BYTES,
    "UPDATE_SIGNATURE_INVALID",
  );
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    fail("UPDATE_SIGNATURE_INVALID");
  }
  exactKeys(envelope, SIGNATURE_KEYS, "UPDATE_SIGNATURE_INVALID");
  if (
    envelope.v !== 1 ||
    envelope.alg !== "EdDSA" ||
    typeof envelope.kid !== "string" ||
    !KID.test(envelope.kid) ||
    typeof envelope.sig !== "string" ||
    !BASE64URL.test(envelope.sig) ||
    envelope.sig.length > 1024
  )
    fail("UPDATE_SIGNATURE_INVALID");
  return envelope;
}

export function verifyUpdateManifest(
  manifestInput,
  signatureInput,
  keys,
  { minimumSequence = -1 } = {},
) {
  const { bytes, manifest } = parseUpdateManifest(manifestInput);
  const envelope = parseSignature(signatureInput);

  if (
    !keys ||
    typeof keys !== "object" ||
    Array.isArray(keys) ||
    !Object.hasOwn(keys, envelope.kid)
  )
    fail("UPDATE_KEY_UNKNOWN");

  let key;
  try {
    key = createPublicKey(keys[envelope.kid]);
  } catch {
    fail("UPDATE_KEY_INVALID");
  }
  if (key.asymmetricKeyType !== "ed25519") fail("UPDATE_KEY_INVALID");

  let signature;
  try {
    signature = Buffer.from(envelope.sig, "base64url");
  } catch {
    fail("UPDATE_SIGNATURE_INVALID");
  }
  if (signature.length !== 64 || !verify(null, bytes, key, signature))
    fail("UPDATE_SIGNATURE_INVALID");

  if (
    !Number.isSafeInteger(minimumSequence) ||
    minimumSequence < -1 ||
    manifest.sequence <= minimumSequence
  )
    fail("UPDATE_ROLLBACK_REJECTED");

  return { ...manifest, keyId: envelope.kid };
}

export function verifyUpdateArchive(data, manifest) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  if (
    !manifest ||
    !Number.isSafeInteger(manifest.archiveBytes) ||
    typeof manifest.archiveSha256 !== "string"
  )
    fail("UPDATE_MANIFEST_INVALID");
  if (data.length !== manifest.archiveBytes) fail("UPDATE_ARCHIVE_SIZE");
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== manifest.archiveSha256) fail("UPDATE_ARCHIVE_HASH");
  return { bytes: data.length, sha256: digest };
}
