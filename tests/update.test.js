import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import path from "node:path";
import {
  releaseDirectoryName,
  safeReleasePath,
  validateArchiveEntries,
  verifyReleaseArchive,
  verifyReleaseManifest,
} from "../src/update.js";

function fixture(overrides = {}) {
  const archive = Buffer.from("verified release archive");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifest = {
    schema: 1,
    product: "KMJ CodeBridge",
    channel: "stable",
    sequence: 42,
    version: "0.2.0",
    revision: "a".repeat(40),
    archive: "https://downloads.kmjtechno.com/codebridge/0.2.0.tar.gz",
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
    nodeMajor: 24,
    publishedAt: "2026-10-03T00:00:00Z",
    keyId: "release-2026",
    ...overrides,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, bytes, privateKey).toString("base64url");
  const keys = {
    "release-2026": publicKey.export({ type: "spki", format: "pem" }),
  };
  return { archive, manifest, bytes, signature, keys, privateKey };
}

test("verifies exact signed manifest bytes with an Ed25519 key", () => {
  const f = fixture();
  assert.deepEqual(
    verifyReleaseManifest(f.bytes, f.signature, f.keys),
    f.manifest,
  );
});

test("enforces a monotonically increasing signed release sequence", () => {
  const f = fixture();
  assert.deepEqual(
    verifyReleaseManifest(f.bytes, f.signature, f.keys, {
      minimumSequence: 41,
    }),
    f.manifest,
  );
  for (const minimumSequence of [42, 43])
    assert.throws(
      () =>
        verifyReleaseManifest(f.bytes, f.signature, f.keys, {
          minimumSequence,
        }),
      /UPDATE_ROLLBACK_REJECTED/,
    );
});

test("rejects tampered manifest bytes and unknown signing keys", () => {
  const f = fixture();
  const tampered = Buffer.from(
    JSON.stringify({ ...f.manifest, version: "9.9.9" }),
  );
  assert.throws(
    () => verifyReleaseManifest(tampered, f.signature, f.keys),
    /UPDATE_SIGNATURE_INVALID/,
  );
  assert.throws(
    () => verifyReleaseManifest(f.bytes, f.signature, {}),
    /UPDATE_KEY_UNKNOWN/,
  );
});

test("rejects non-Ed25519 signing keys", () => {
  const f = fixture();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
  assert.throws(
    () =>
      verifyReleaseManifest(f.bytes, f.signature, {
        "release-2026": rsa.export({ type: "spki", format: "pem" }),
      }),
    /UPDATE_KEY_INVALID/,
  );
});

test("requires exact archive size and SHA-256", () => {
  const f = fixture();
  assert.deepEqual(verifyReleaseArchive(f.archive, f.manifest), {
    bytes: f.archive.length,
    sha256: f.manifest.sha256,
  });
  assert.throws(
    () =>
      verifyReleaseArchive(
        Buffer.concat([f.archive, Buffer.from("x")]),
        f.manifest,
      ),
    /UPDATE_ARCHIVE_SIZE_MISMATCH/,
  );
  assert.throws(
    () =>
      verifyReleaseArchive(Buffer.from("different archive"), {
        ...f.manifest,
        bytes: Buffer.byteLength("different archive"),
      }),
    /UPDATE_ARCHIVE_HASH_MISMATCH/,
  );
});

test("release target is deterministic and contained under the release root", () => {
  const f = fixture();
  assert.equal(releaseDirectoryName(f.manifest), `0.2.0-${"a".repeat(12)}`);
  assert.equal(
    safeReleasePath("/opt/kmj-codebridge/releases", f.manifest),
    path.resolve("/opt/kmj-codebridge/releases", `0.2.0-${"a".repeat(12)}`),
  );
});

test("archive layout rejects absolute and traversal entries", () => {
  assert.equal(
    validateArchiveEntries([
      "kmj-codebridge/package.json",
      "kmj-codebridge/src/cli.js",
    ]),
    true,
  );
  for (const entries of [
    ["/etc/passwd"],
    ["../outside"],
    ["release/../../outside"],
    ["release\\windows-path"],
  ])
    assert.throws(
      () => validateArchiveEntries(entries),
      /UPDATE_ARCHIVE_LAYOUT_INVALID/,
    );
});

test("manifest rejects unsafe archive URLs and unexpected fields", () => {
  for (const overrides of [
    { archive: "http://downloads.example/release.tar.gz" },
    { archive: "https://user:pass@downloads.example/release.tar.gz" },
    { archive: "https://localhost/release.tar.gz" },
    { archive: "https://127.0.0.1/release.tar.gz" },
    { archive: "https://10.1.2.3/release.tar.gz" },
    { archive: "https://192.168.1.2/release.tar.gz" },
    { archive: "https://[::1]/release.tar.gz" },
    { archive: "https://host.local/release.tar.gz" },
    { archive: "https://downloads.example/release.zip" },
    { extra: "not-allowed" },
  ]) {
    const f = fixture(overrides);
    assert.throws(
      () => verifyReleaseManifest(f.bytes, f.signature, f.keys),
      /UPDATE_MANIFEST_INVALID/,
    );
  }
});
