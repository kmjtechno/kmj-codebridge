import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { latestSignedRelease } from "../scripts/latest-signed-release.mjs";

const sha = (letter) => letter.repeat(40);
const A = sha("a");
const B = sha("b");
const C = sha("c");

function fixtures(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-release-crypto-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyPair = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const keys = {
    "test-owner": keyPair.publicKey.export({ format: "pem", type: "spki" }),
  };
  const add = (
    revision,
    sequence,
    {
      signer = keyPair.privateKey,
      signerKeyId = "test-owner",
      manifestOverrides = {},
      signature = true,
    } = {},
  ) => {
    const directory = path.join(root, revision);
    fs.mkdirSync(directory, { mode: 0o700 });
    const manifest = {
      schema: 1,
      product: "KMJ CodeBridge",
      channel: "stable",
      sequence,
      version: "0.3.2",
      revision,
      archive:
        "https://kmjtechno.com/codebridge/releases/stable/" +
        revision +
        "/kmj-codebridge-0.3.2-" +
        revision.slice(0, 12) +
        ".tar.gz",
      sha256: "1".repeat(64),
      bytes: 2151242,
      nodeMajor: 24,
      publishedAt: "2026-11-15T07:08:54.618Z",
      keyId: signerKeyId,
      ...manifestOverrides,
    };
    const manifestPath = path.join(directory, "release-manifest.json");
    const signaturePath = path.join(directory, "release-manifest.sig");
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(manifestPath, bytes);
    if (signature) {
      fs.writeFileSync(
        signaturePath,
        sign(null, bytes, signer).toString("base64url") + "\n",
      );
    }
    return { manifestPath, signaturePath, bytes, directory };
  };
  const select = (options = {}) =>
    latestSignedRelease(root, { trustedKeys: keys, ...options });
  return { root, add, select, keys, other };
}

test("highest cryptographically signed Stable sequence wins", (t) => {
  const f = fixtures(t);
  f.add(A, 24);
  f.add(C, 1);
  f.add(B, 26);
  assert.deepEqual(f.select(), { sequence: 26, revision: B });
  assert.deepEqual(f.select({ minimumSequence: 25 }), {
    sequence: 26,
    revision: B,
  });
});

test("unsigned higher sequence cannot win and fails closed", (t) => {
  const f = fixtures(t);
  f.add(A, 25);
  f.add(B, 999, { signature: false });
  assert.throws(() => f.select(), /RELEASE_METADATA_UNAVAILABLE/);
});

test("invalid signature on higher sequence is a hard blocker", (t) => {
  const f = fixtures(t);
  f.add(A, 25);
  const candidate = f.add(B, 26);
  fs.writeFileSync(candidate.signaturePath, "A".repeat(86) + "\n");
  assert.throws(() => f.select(), /UPDATE_SIGNATURE_INVALID/);
});

test("tampered signed manifest bytes are not trusted", (t) => {
  const f = fixtures(t);
  const row = f.add(A, 25);
  const changed = row.bytes
    .toString("utf8")
    .replace('"sequence": 25', '"sequence": 26');
  fs.writeFileSync(row.manifestPath, changed);
  assert.throws(() => f.select(), /UPDATE_SIGNATURE_INVALID/);
});

test("untrusted kid and wrong-key signatures fail closed", (t) => {
  const f = fixtures(t);
  f.add(A, 25, { signerKeyId: "unknown" });
  assert.throws(() => f.select(), /UPDATE_KEY_UNKNOWN/);
  fs.rmSync(path.join(f.root, A), { recursive: true, force: true });
  f.add(B, 26, { signer: f.other.privateKey });
  assert.throws(() => f.select(), /UPDATE_SIGNATURE_INVALID/);
});

test("symlinked manifest or signature is refused without following", (t) => {
  const f = fixtures(t);
  const row = f.add(A, 25);
  for (const file of [row.manifestPath, row.signaturePath]) {
    const target = file + ".safe";
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    assert.throws(() => f.select(), /RELEASE_METADATA_UNSAFE/);
    fs.unlinkSync(file);
    fs.renameSync(target, file);
  }
});

test("symlinked catalog directory is refused", (t) => {
  const f = fixtures(t);
  const row = f.add(A, 25);
  const replacement = path.join(f.root, "real");
  fs.renameSync(row.directory, replacement);
  fs.symlinkSync(replacement, row.directory, "dir");
  assert.throws(() => f.select(), /RELEASE_DIRECTORY_UNSAFE/);
});

test("missing/empty catalog, missing trust and invalid floor all deny", (t) => {
  const f = fixtures(t);
  assert.throws(() => f.select(), /RELEASE_NONE_FOUND/);
  f.add(A, 25);
  assert.throws(
    () => latestSignedRelease(f.root),
    /RELEASE_TRUST_KEYS_REQUIRED/,
  );
  assert.throws(
    () => f.select({ trustedKeys: {} }),
    /RELEASE_TRUST_KEYS_REQUIRED/,
  );
  assert.throws(
    () => f.select({ minimumSequence: -2 }),
    /RELEASE_MINIMUM_SEQUENCE_INVALID/,
  );
});

test("duplicate signed sequence is ambiguous and fails", (t) => {
  const f = fixtures(t);
  f.add(A, 25);
  f.add(B, 25);
  assert.throws(() => f.select(), /RELEASE_SEQUENCE_DUPLICATE/);
});

test("rollback sequence cannot be reported as latest signed", (t) => {
  const f = fixtures(t);
  f.add(A, 25);
  assert.throws(
    () => f.select({ minimumSequence: 25 }),
    /RELEASE_ROLLBACK_REJECTED/,
  );
});

test("signed revision/dir mismatch and wrong archive location reject", (t) => {
  const f = fixtures(t);
  f.add(A, 25, { manifestOverrides: { revision: B } });
  assert.throws(() => f.select(), /RELEASE_REVISION_DIR_MISMATCH/);
  fs.rmSync(path.join(f.root, A), { recursive: true, force: true });
  f.add(B, 26, {
    manifestOverrides: {
      archive: "https://example.org/another/valid.tar.gz",
    },
  });
  assert.throws(() => f.select(), /RELEASE_ARCHIVE_IDENTITY_INVALID/);
});

test("signed Beta manifest in stable catalog fails", (t) => {
  const f = fixtures(t);
  f.add(A, 25, { manifestOverrides: { channel: "beta" } });
  assert.throws(() => f.select(), /RELEASE_STABLE_MANIFEST_INVALID/);
});

test("hardlinked manifest and malformed trust map are refused", (t) => {
  const f = fixtures(t);
  const row = f.add(A, 25);
  fs.linkSync(row.manifestPath, row.manifestPath + ".dup");
  assert.throws(() => f.select(), /RELEASE_METADATA_UNSAFE/);
  assert.throws(
    () => f.select({ trustedKeys: { owner: "not-a-public-key" } }),
    /RELEASE_TRUST_KEYS_INVALID/,
  );
});

test("missing signed manifest files never silently become a signed release", (t) => {
  const f = fixtures(t);
  f.add(A, 25, { signature: false });
  assert.throws(() => f.select(), /RELEASE_METADATA_UNAVAILABLE/);
});

test("a revision directory without a manifest cannot hide a newer signed release", (t) => {
  const f = fixtures(t);
  f.add(A, 25);
  fs.mkdirSync(path.join(f.root, B), { mode: 0o700 });
  assert.throws(() => f.select(), /RELEASE_MANIFEST_MISSING/);
});

test("fixture generated signing key is ephemeral and never exported privately", (t) => {
  const f = fixtures(t);
  f.add(A, 25);
  const serialized = JSON.stringify(f.select());
  assert.doesNotMatch(serialized, /PRIVATE KEY/);
  assert.equal(serialized.includes("sequence"), true);
});
