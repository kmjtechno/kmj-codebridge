import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  p520LauncherApprovalBytes,
  verifyP520LauncherApproval,
} from "../src/p520-launcher-approval.js";

const MODEL_SHA =
  "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8";
const BINARY_SHA =
  "3a192bd0dfb3aa56bc544b62cb0648d1ad8a9d9147df0e87132404645dce9fce";
const ISSUED = "2026-11-01T11:00:00.000Z";
const EXPIRES = "2026-11-01T11:04:00.000Z";
const NOW = Date.parse("2026-11-01T11:01:00.000Z");

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedPublicKeyPem = publicKey.export({
    type: "spki",
    format: "pem",
  });
  const trustedSpkiSha256 = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const manifest = {
    schema: 1,
    deviceId: "kmj-kmj-codebridge-desktop-5fvjmet",
    hostname: "DESKTOP-5FVJMET",
    modelBasename: "Qwen3.5-9B-Q4_K_M.gguf",
    modelSha256: MODEL_SHA,
    binarySha256: BINARY_SHA,
    listenerHost: "127.0.0.1",
    listenerPort: 20145,
    binaryPath: "C:\\KMJ\\runtime\\cuda12\\llama-server.exe",
    modelPath: "C:\\KMJ\\models\\Qwen3.5-9B-Q4_K_M.gguf",
    processId: 1248,
    processCreatedAt: "2026-11-01T10:58:00.000Z",
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    nonce: "0123456789abcdef0123456789abcdef",
  };
  const { schema, issuedAt, expiresAt, nonce, ...observed } = manifest;
  const args = {
    manifest,
    signatureBase64: sign(
      null,
      p520LauncherApprovalBytes(manifest),
      privateKey,
    ).toString("base64"),
    trustedPublicKeyPem,
    trustedSpkiSha256,
    observed,
    now: NOW,
  };
  return { args, privateKey };
}

test("even a valid owner signature and matching claimed process cannot activate local AI", () => {
  const { args } = fixture();
  const result = verifyP520LauncherApproval(args);
  assert.deepEqual(result, {
    status: "OWNER_SUPERVISOR_ATTESTATION_REQUIRED",
    signatureVerified: true,
    ownerAttested: false,
    mayEnableInference: false,
  });
});

test("null, primitive and array approval envelopes fail closed without throwing", () => {
  for (const input of [null, false, 0, 42, "", "invalid", [], [null]]) {
    assert.deepEqual(verifyP520LauncherApproval(input), {
      status: "OWNER_APPROVAL_INPUT_INVALID",
      signatureVerified: false,
      ownerAttested: false,
      mayEnableInference: false,
    });
  }
});

test("accessor, Symbol and Proxy approvals fail closed", () => {
  const { args } = fixture();
  const getter = () => {
    throw new Error("UNTRUSTED_GETTER_EXECUTED");
  };
  const inputWithGetter = Object.defineProperty({ ...args }, "manifest", {
    enumerable: true,
    get: getter,
  });
  const observedWithGetter = Object.defineProperty(
    { ...args.observed },
    "processId",
    { enumerable: true, get: getter },
  );
  const manifestWithGetter = Object.defineProperty(
    { ...args.manifest },
    "nonce",
    { enumerable: true, get: getter },
  );
  const inputWithSymbol = { ...args, [Symbol("hidden")]: "value" };
  const inputProxy = new Proxy({ ...args }, { get: getter });
  const observedProxy = new Proxy({ ...args.observed }, { get: getter });
  const manifestProxy = new Proxy({ ...args.manifest }, { get: getter });

  for (const input of [
    inputWithGetter,
    inputWithSymbol,
    inputProxy,
    { ...args, observed: observedWithGetter },
    { ...args, observed: observedProxy },
    { ...args, manifest: manifestWithGetter },
    { ...args, manifest: manifestProxy },
  ]) {
    let result;
    assert.doesNotThrow(() => {
      result = verifyP520LauncherApproval(input);
    });
    assert.equal(result.ownerAttested, false);
    assert.equal(result.mayEnableInference, false);
    assert.equal(result.signatureVerified, false);
  }
  assert.throws(
    () => p520LauncherApprovalBytes(manifestWithGetter),
    /P520_LAUNCHER_MANIFEST_INVALID/,
  );
  assert.throws(
    () => p520LauncherApprovalBytes(manifestProxy),
    /P520_LAUNCHER_MANIFEST_INVALID/,
  );
});

test("without an independently pinned owner trust anchor all approvals are denied", () => {
  const { args } = fixture();
  for (const patch of [
    { trustedPublicKeyPem: undefined },
    { trustedSpkiSha256: undefined },
    { trustedSpkiSha256: "a".repeat(63) },
    { trustedSpkiSha256: "a".repeat(64) },
  ]) {
    assert.equal(
      verifyP520LauncherApproval({ ...args, ...patch }).ownerAttested,
      false,
    );
    assert.equal(
      verifyP520LauncherApproval({ ...args, ...patch }).mayEnableInference,
      false,
    );
  }
  assert.equal(
    verifyP520LauncherApproval({ ...args, trustedPublicKeyPem: undefined })
      .status,
    "OWNER_TRUST_ANCHOR_MISSING",
  );
});

test("tampering a signed model, PID, hostname or launcher path fails closed", () => {
  const { args } = fixture();
  for (const [field, value] of [
    ["modelSha256", "0".repeat(64)],
    ["binarySha256", "0".repeat(64)],
    ["listenerPort", 20146],
    ["hostname", "OTHER-PC"],
    ["processId", 1250],
    ["binaryPath", "C:\\KMJ\\runtime\\wrong.exe"],
    ["issuedAt", "2026-11-01T11:00:01.000Z"],
    ["nonce", "f".repeat(32)],
  ]) {
    const result = verifyP520LauncherApproval({
      ...args,
      manifest: { ...args.manifest, [field]: value },
    });
    assert.equal(result.ownerAttested, false);
    assert.equal(result.signatureVerified, false);
  }
});

test("a substituted signature or unapproved key cannot authorize the launcher", () => {
  const { args } = fixture();
  const other = fixture();
  const wrongSignature = verifyP520LauncherApproval({
    ...args,
    signatureBase64: other.args.signatureBase64,
  });
  assert.equal(wrongSignature.status, "OWNER_APPROVAL_SIGNATURE_INVALID");
  const wrongKey = verifyP520LauncherApproval({
    ...args,
    trustedPublicKeyPem: other.args.trustedPublicKeyPem,
  });
  assert.equal(wrongKey.status, "OWNER_TRUST_ANCHOR_MISMATCH");
  assert.equal(
    verifyP520LauncherApproval({ ...args, signatureBase64: "bogus" })
      .ownerAttested,
    false,
  );
});

test("stale, future and excessively long owner approvals fail closed", () => {
  const { args, privateKey } = fixture();
  assert.equal(
    verifyP520LauncherApproval({ ...args, now: Date.parse(EXPIRES) }).status,
    "OWNER_APPROVAL_EXPIRED_OR_EARLY",
  );
  assert.equal(
    verifyP520LauncherApproval({ ...args, now: Date.parse(ISSUED) - 1 }).status,
    "OWNER_APPROVAL_EXPIRED_OR_EARLY",
  );
  const long = {
    ...args.manifest,
    expiresAt: "2026-11-01T11:06:00.000Z",
  };
  assert.throws(
    () => p520LauncherApprovalBytes(long),
    /P520_LAUNCHER_MANIFEST_INVALID/,
  );
  const invalid = verifyP520LauncherApproval({
    ...args,
    manifest: long,
    signatureBase64: sign(null, Buffer.from("wrong"), privateKey).toString(
      "base64",
    ),
  });
  assert.equal(invalid.status, "OWNER_APPROVAL_MANIFEST_INVALID");
});

test("injected fields, Windows UNC, traversal and alternate data stream paths are rejected", () => {
  const { args } = fixture();
  for (const patch of [
    { extra: "attacker-controlled" },
    { binaryPath: "\\\\host\\share\\llama-server.exe" },
    { binaryPath: "C:\\KMJ\\..\\llama-server.exe" },
    { binaryPath: "C:\\KMJ\\llama-server.exe:stream" },
    { modelPath: "D:\\other.gguf" },
    { processId: -1 },
    { processCreatedAt: "not-a-date" },
    { nonce: "0".repeat(31) },
  ]) {
    assert.throws(
      () => p520LauncherApprovalBytes({ ...args.manifest, ...patch }),
      /P520_LAUNCHER_MANIFEST_INVALID/,
    );
  }
});

test("Windows reserved device names and trailing dot/space aliases fail closed", () => {
  const { args } = fixture();
  for (const binaryPath of [
    "C:\\KMJ\\CON\\llama-server.exe",
    "C:\\KMJ\\AUX.txt\\llama-server.exe",
    "C:\\KMJ\\NUL\\llama-server.exe",
    "C:\\KMJ\\CONIN$\\llama-server.exe",
    "C:\\KMJ\\CONOUT$\\llama-server.exe",
    "C:\\KMJ\\COM1.log\\llama-server.exe",
    "C:\\KMJ\\LPT9\\llama-server.exe",
    "C:\\KMJ\\COM¹\\llama-server.exe",
    "C:\\KMJ\\LPT².txt\\llama-server.exe",
    "C:\\KMJ\\COM³\\llama-server.exe",
    "C:\\KMJ\\bad.\\llama-server.exe",
    "C:\\KMJ\\bad \\llama-server.exe",
  ]) {
    assert.throws(
      () => p520LauncherApprovalBytes({ ...args.manifest, binaryPath }),
      /P520_LAUNCHER_MANIFEST_INVALID/,
      binaryPath,
    );
  }
  assert.equal(verifyP520LauncherApproval(args).signatureVerified, true);
});

test("owner preflight refuses process creation after approval issuance", () => {
  const { args } = fixture();
  for (const processCreatedAt of [
    "2026-11-01T11:00:00.001Z",
    "2026-11-01T11:03:00.000Z",
  ]) {
    const manifest = { ...args.manifest, processCreatedAt };
    assert.throws(
      () => p520LauncherApprovalBytes(manifest),
      /P520_LAUNCHER_MANIFEST_INVALID/,
    );
    const result = verifyP520LauncherApproval({ ...args, manifest });
    assert.equal(result.status, "OWNER_APPROVAL_MANIFEST_INVALID");
    assert.equal(result.ownerAttested, false);
    assert.equal(result.mayEnableInference, false);
  }
});

test("fake or changed supervisor observations never satisfy an approval", () => {
  const { args } = fixture();
  for (const observed of [
    undefined,
    {},
    { ...args.observed, processId: 1250 },
    { ...args.observed, binarySha256: "f".repeat(64) },
    { ...args.observed, extra: "spoofed" },
    { ...args.observed, listenerHost: "0.0.0.0" },
  ]) {
    const result = verifyP520LauncherApproval({ ...args, observed });
    assert.equal(result.ownerAttested, false);
    assert.equal(result.mayEnableInference, false);
    assert.match(result.status, /^OWNER_RUNTIME_OBSERVATION_/);
  }
});

test("a V2 preliminary PowerShell receipt by itself is never an approved launch", () => {
  const { args } = fixture();
  const ownerV2 = {
    ATTESTATION: "PRELIMINARY_READONLY_OWNER_APPROVAL_PENDING",
    MODEL_SHA256: "PASS",
    BINARY_SHA256: BINARY_SHA,
    AUTHENTICODE_STATUS: "NotSigned",
  };
  const result = verifyP520LauncherApproval({
    ...args,
    observed: ownerV2,
  });
  assert.equal(result.status, "OWNER_RUNTIME_OBSERVATION_INVALID");
  assert.equal(result.ownerAttested, false);
});

test("oversized, malformed or embedded-NUL owner key is rejected before parsing", () => {
  const { args } = fixture();
  for (const trustedPublicKeyPem of [
    "A".repeat(4097),
    "-----BEGIN PUBLIC KEY-----\0not-pem",
    "x".repeat(49),
  ]) {
    const result = verifyP520LauncherApproval({
      ...args,
      trustedPublicKeyPem,
    });
    assert.deepEqual(result, {
      status: "OWNER_TRUST_ANCHOR_MISSING",
      signatureVerified: false,
      ownerAttested: false,
      mayEnableInference: false,
    });
  }
});

test("replayed signed envelope cannot elevate without a protected supervisor", () => {
  const { args } = fixture();
  for (let i = 0; i < 3; i++) {
    const result = verifyP520LauncherApproval(args);
    assert.equal(result.status, "OWNER_SUPERVISOR_ATTESTATION_REQUIRED");
    assert.equal(result.signatureVerified, true);
    assert.equal(result.ownerAttested, false);
    assert.equal(result.mayEnableInference, false);
  }
});
