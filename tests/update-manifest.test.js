import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  parseUpdateManifest,
  verifyUpdateArchive,
  verifyUpdateManifest,
} from "../src/update-manifest.js";
import { buildSignedUpdateManifest } from "../scripts/sign-runtime-manifest.js";

function fixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const archive = Buffer.from("verified immutable release archive");
  const runtimeManifest = {
    product: "KMJ CodeBridge",
    version: "0.2.0",
    revision: "a".repeat(40),
    archive: "kmj-codebridge-0.2.0-aaaaaaaaaaaa.tar.gz",
    bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
    format: "source-runtime",
    requires: "Node.js 24; npm ci --ignore-scripts",
    signed: false,
    ...overrides.runtimeManifest,
  };
  const signed = buildSignedUpdateManifest({
    runtimeManifest,
    archiveUrl:
      overrides.archiveUrl ??
      "https://releases.kmjtechno.com/codebridge/kmj-codebridge-0.2.0-aaaaaaaaaaaa.tar.gz",
    sequence: overrides.sequence ?? 42,
    kid: overrides.kid ?? "release-2026",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    channel: overrides.channel ?? "stable",
  });
  return {
    archive,
    signed,
    publicPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

test("verifies an Ed25519-signed update manifest and archive", () => {
  const { archive, signed, publicPem } = fixture();
  const manifest = verifyUpdateManifest(
    signed.manifestBytes,
    signed.signatureBytes,
    { "release-2026": publicPem },
    { minimumSequence: 41 },
  );
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.sequence, 42);
  assert.equal(manifest.keyId, "release-2026");
  assert.deepEqual(verifyUpdateArchive(archive, manifest), {
    bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  });
});

test("signature covers the exact manifest bytes", () => {
  const { signed, publicPem } = fixture();
  const changed = Buffer.from(
    signed.manifestBytes.toString("utf8").replace('"sequence": 42', '"sequence": 43'),
  );
  assert.throws(
    () =>
      verifyUpdateManifest(changed, signed.signatureBytes, {
        "release-2026": publicPem,
      }),
    /UPDATE_SIGNATURE_INVALID/,
  );
});

test("unknown and non-Ed25519 release keys are rejected", () => {
  const { signed } = fixture();
  assert.throws(
    () => verifyUpdateManifest(signed.manifestBytes, signed.signatureBytes, {}),
    /UPDATE_KEY_UNKNOWN/,
  );
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      verifyUpdateManifest(signed.manifestBytes, signed.signatureBytes, {
        "release-2026": publicKey.export({ type: "spki", format: "pem" }),
      }),
    /UPDATE_KEY_INVALID/,
  );
});

test("sequence is strictly monotonic to reject downgrade/replay", () => {
  const { signed, publicPem } = fixture({ sequence: 42 });
  for (const minimumSequence of [42, 43]) {
    assert.throws(
      () =>
        verifyUpdateManifest(
          signed.manifestBytes,
          signed.signatureBytes,
          { "release-2026": publicPem },
          { minimumSequence },
        ),
      /UPDATE_ROLLBACK_REJECTED/,
    );
  }
});

test("manifest rejects unsafe archive destinations and unknown fields", () => {
  const { signed } = fixture();
  const base = JSON.parse(signed.manifestBytes);
  for (const archiveUrl of [
    "http://releases.kmjtechno.com/file.tar.gz",
    "https://localhost/file.tar.gz",
    "https://127.0.0.1/file.tar.gz",
    "https://10.1.2.3/file.tar.gz",
    "https://192.168.1.2/file.tar.gz",
    "https://172.16.1.2/file.tar.gz",
    "https://user:pass@releases.kmjtechno.com/file.tar.gz",
    "https://releases.kmjtechno.com/file.zip",
  ]) {
    assert.throws(
      () =>
        parseUpdateManifest(
          Buffer.from(JSON.stringify({ ...base, archiveUrl }) + "\n"),
        ),
      /UPDATE_MANIFEST_INVALID/,
    );
  }
  assert.throws(
    () =>
      parseUpdateManifest(
        Buffer.from(JSON.stringify({ ...base, ignored: true }) + "\n"),
      ),
    /UPDATE_MANIFEST_INVALID/,
  );
});

test("archive size and SHA-256 must both match", () => {
  const { archive, signed, publicPem } = fixture();
  const manifest = verifyUpdateManifest(
    signed.manifestBytes,
    signed.signatureBytes,
    { "release-2026": publicPem },
  );
  assert.throws(
    () => verifyUpdateArchive(Buffer.concat([archive, Buffer.from("x")]), manifest),
    /UPDATE_ARCHIVE_SIZE/,
  );
  const tampered = Buffer.from(archive);
  tampered[0] ^= 1;
  assert.throws(
    () => verifyUpdateArchive(tampered, manifest),
    /UPDATE_ARCHIVE_HASH/,
  );
});

test("signer refuses archive URL basename drift", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      buildSignedUpdateManifest({
        runtimeManifest: {
          product: "KMJ CodeBridge",
          version: "0.2.0",
          revision: "a".repeat(40),
          archive: "expected.tar.gz",
          bytes: 1,
          sha256: "b".repeat(64),
          format: "source-runtime",
          signed: false,
        },
        archiveUrl: "https://releases.kmjtechno.com/different.tar.gz",
        sequence: 1,
        kid: "release",
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    /UPDATE_ARCHIVE_URL_MISMATCH/,
  );
});
