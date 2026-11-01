import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import path from "node:path";

// Cryptographic *preflight* only. This module cannot attest a Windows process
// or approve inference. A future owner-protected supervisor must independently
// prove the current PID, listener, executable, model and launcher ACL.
const DEVICE = "kmj-kmj-codebridge-desktop-5fvjmet";
const HOST = "DESKTOP-5FVJMET";
const MODEL = "Qwen3.5-9B-Q4_K_M.gguf";
const MODEL_SHA =
  "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8";
const BINARY_SHA =
  "3a192bd0dfb3aa56bc544b62cb0648d1ad8a9d9147df0e87132404645dce9fce";
const PORT = 20145;
const MAX_LIFETIME_MS = 300000;
const HEX64 = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const FIELDS = Object.freeze([
  "schema",
  "deviceId",
  "hostname",
  "modelBasename",
  "modelSha256",
  "binarySha256",
  "listenerHost",
  "listenerPort",
  "binaryPath",
  "modelPath",
  "processId",
  "processCreatedAt",
  "issuedAt",
  "expiresAt",
  "nonce",
]);
const WITNESS_FIELDS = Object.freeze([
  "deviceId",
  "hostname",
  "modelBasename",
  "modelSha256",
  "binarySha256",
  "listenerHost",
  "listenerPort",
  "binaryPath",
  "modelPath",
  "processId",
  "processCreatedAt",
]);

function exactFields(obj, fields) {
  return (
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    Object.getPrototypeOf(obj) === Object.prototype &&
    Object.keys(obj).length === fields.length &&
    fields.every((field) => Object.hasOwn(obj, field))
  );
}

function windowsFile(value) {
  return (
    typeof value === "string" &&
    value.length >= 4 &&
    value.length <= 260 &&
    /^[A-Za-z]:\\/.test(value) &&
    !/[\u0000-\u001f<>:"|?*]/.test(value.slice(2)) &&
    !value
      .slice(3)
      .split(/[\\/]/)
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(
            part,
          ),
      ) &&
    path.win32.isAbsolute(value) &&
    path.win32.normalize(value) === value
  );
}

function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : null;
}

function identityValid(value) {
  return (
    value.deviceId === DEVICE &&
    value.hostname === HOST &&
    value.modelBasename === MODEL &&
    value.modelSha256 === MODEL_SHA &&
    value.binarySha256 === BINARY_SHA &&
    value.listenerHost === "127.0.0.1" &&
    value.listenerPort === PORT &&
    windowsFile(value.binaryPath) &&
    windowsFile(value.modelPath) &&
    value.modelPath
      .toLowerCase()
      .endsWith("\\models\\qwen3.5-9b-q4_k_m.gguf") &&
    value.binaryPath.toLowerCase().endsWith("\\llama-server.exe") &&
    Number.isSafeInteger(value.processId) &&
    value.processId > 0 &&
    value.processId <= 0x7fffffff &&
    date(value.processCreatedAt) !== null
  );
}

// Exact canonical field order prevents signing unexpected attributes.
export function p520LauncherApprovalBytes(manifest) {
  if (!exactFields(manifest, FIELDS) || manifest.schema !== 1)
    throw new TypeError("P520_LAUNCHER_MANIFEST_INVALID");
  if (!identityValid(manifest) || !NONCE.test(manifest.nonce))
    throw new TypeError("P520_LAUNCHER_MANIFEST_INVALID");
  const issued = date(manifest.issuedAt);
  const expires = date(manifest.expiresAt);
  if (
    issued === null ||
    expires === null ||
    expires <= issued ||
    expires - issued > MAX_LIFETIME_MS
  )
    throw new TypeError("P520_LAUNCHER_MANIFEST_INVALID");
  return Buffer.from(
    "KMJ-P520-LLAMACPP-OWNER-APPROVAL-V1\n" +
      JSON.stringify(FIELDS.map((key) => manifest[key])),
    "utf8",
  );
}

function denied(reason, signatureVerified = false) {
  return {
    status: reason,
    signatureVerified,
    ownerAttested: false,
    mayEnableInference: false,
  };
}

// The public key and pinned SPKI hash must come from independently protected
// owner policy, never from this manifest, an MCP request or a model response.
// The observed object is caller data, not an authenticated supervisor witness.
export function verifyP520LauncherApproval({
  manifest,
  signatureBase64,
  trustedPublicKeyPem,
  trustedSpkiSha256,
  observed,
  now = Date.now(),
} = {}) {
  if (
    typeof trustedPublicKeyPem !== "string" ||
    typeof trustedSpkiSha256 !== "string" ||
    !HEX64.test(trustedSpkiSha256)
  )
    return denied("OWNER_TRUST_ANCHOR_MISSING");
  if (!Number.isSafeInteger(now) || now < 0)
    return denied("OWNER_APPROVAL_TIME_INVALID");
  let payload;
  try {
    payload = p520LauncherApprovalBytes(manifest);
  } catch {
    return denied("OWNER_APPROVAL_MANIFEST_INVALID");
  }
  const issued = date(manifest.issuedAt);
  const expires = date(manifest.expiresAt);
  if (now < issued || now >= expires)
    return denied("OWNER_APPROVAL_EXPIRED_OR_EARLY");
  if (
    typeof signatureBase64 !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)
  )
    return denied("OWNER_APPROVAL_SIGNATURE_INVALID");
  const signature = Buffer.from(signatureBase64, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== signatureBase64
  )
    return denied("OWNER_APPROVAL_SIGNATURE_INVALID");
  let key;
  try {
    key = createPublicKey(trustedPublicKeyPem);
    if (key.asymmetricKeyType !== "ed25519")
      return denied("OWNER_TRUST_ANCHOR_INVALID");
    const spki = key.export({ type: "spki", format: "der" });
    const fingerprint = createHash("sha256").update(spki).digest("hex");
    if (fingerprint !== trustedSpkiSha256)
      return denied("OWNER_TRUST_ANCHOR_MISMATCH");
    if (!verifySignature(null, payload, key, signature))
      return denied("OWNER_APPROVAL_SIGNATURE_INVALID");
  } catch {
    return denied("OWNER_TRUST_ANCHOR_INVALID");
  }

  // This comparison cannot establish live PID provenance or ACL integrity.
  if (!exactFields(observed, WITNESS_FIELDS) || !identityValid(observed))
    return denied("OWNER_RUNTIME_OBSERVATION_INVALID", true);
  for (const field of WITNESS_FIELDS) {
    if (observed[field] !== manifest[field])
      return denied("OWNER_RUNTIME_OBSERVATION_MISMATCH", true);
  }
  return denied("OWNER_SUPERVISOR_ATTESTATION_REQUIRED", true);
}
