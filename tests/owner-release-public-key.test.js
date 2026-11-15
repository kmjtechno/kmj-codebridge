import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  ownerPublicKey,
  REQUIRED_RELEASES,
  verifyAllReleaseSignatures,
} from "../scripts/verify-owner-release-public-key.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-owner-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const pin = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  for (const [sequence, revision] of REQUIRED_RELEASES) {
    const release = path.join(dir, revision);
    fs.mkdirSync(release);
    const manifest = Buffer.from(
      JSON.stringify({
        schema: 1,
        product: "KMJ CodeBridge",
        channel: "stable",
        sequence,
        revision,
        version: "0.3.2",
        keyId: "kmj-release-2026",
        nodeMajor: 24,
        sha256: "a".repeat(64),
        bytes: 12345,
        archive:
          "https://kmjtechno.com/codebridge/releases/stable/" +
          revision +
          "/kmj-codebridge-0.3.2-" +
          revision.slice(0, 12) +
          ".tar.gz",
      }),
    );
    const signature = sign(null, manifest, privateKey);
    fs.writeFileSync(path.join(release, "release-manifest.json"), manifest);
    fs.writeFileSync(
      path.join(release, "release-manifest.sig"),
      signature.toString("base64url") + "\n",
    );
  }
  return { dir, pem, pin, privateKey };
}

test("exact ten Ed25519 signatures pass only with matching SPKI pin", (t) => {
  const f = fixture(t);
  const out = verifyAllReleaseSignatures({
    publicKeyPem: f.pem,
    releasesRoot: f.dir,
    expectedFingerprint: f.pin,
  });
  assert.deepEqual(out, { fingerprint: f.pin, passed: 10, required: 10 });
  assert.equal(ownerPublicKey(f.pem).fingerprint, f.pin);
});

test("a PEM from another owner must fail before reading releases", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      verifyAllReleaseSignatures({
        publicKeyPem: f.pem,
        releasesRoot: f.dir,
        expectedFingerprint: "f".repeat(64),
      }),
    /OWNER_PUBLIC_KEY_FINGERPRINT_MISMATCH/,
  );
});

test("private PEM input is explicitly rejected", (t) => {
  const f = fixture(t);
  assert.throws(
    () => ownerPublicKey(f.privateKey.export({ type: "pkcs8", format: "pem" })),
    /OWNER_PUBLIC_KEY_FORMAT_INVALID/,
  );
});

test("public PEM must represent Ed25519, never RSA", () => {
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  assert.throws(
    () => ownerPublicKey(publicKey.export({ type: "spki", format: "pem" })),
    /OWNER_PUBLIC_KEY_NOT_ED25519/,
  );
});

test("tampered manifest bytes reject the original signature", (t) => {
  const f = fixture(t);
  const [sequence, revision] = REQUIRED_RELEASES[0];
  const file = path.join(f.dir, revision, "release-manifest.json");
  const item = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(item.sequence, sequence);
  item.bytes += 1;
  fs.writeFileSync(file, JSON.stringify(item));
  assert.throws(
    () =>
      verifyAllReleaseSignatures({
        publicKeyPem: f.pem,
        releasesRoot: f.dir,
        expectedFingerprint: f.pin,
      }),
    /RELEASE_SIGNATURE_VERIFICATION_FAILED/,
  );
});

test("stale/wrong sequence is rejected before crypto", (t) => {
  const f = fixture(t);
  const [, revision] = REQUIRED_RELEASES[2];
  const file = path.join(f.dir, revision, "release-manifest.json");
  const item = JSON.parse(fs.readFileSync(file, "utf8"));
  item.sequence = 999;
  fs.writeFileSync(file, JSON.stringify(item));
  assert.throws(
    () =>
      verifyAllReleaseSignatures({
        publicKeyPem: f.pem,
        releasesRoot: f.dir,
        expectedFingerprint: f.pin,
      }),
    /RELEASE_MANIFEST_IDENTITY_INVALID/,
  );
});

test("signature with malformed base64url is rejected", (t) => {
  const f = fixture(t);
  const [, revision] = REQUIRED_RELEASES[0];
  fs.writeFileSync(
    path.join(f.dir, revision, "release-manifest.sig"),
    "ATTACKER-INSERTED-BAD-SIGNATURE\n",
  );
  assert.throws(
    () =>
      verifyAllReleaseSignatures({
        publicKeyPem: f.pem,
        releasesRoot: f.dir,
        expectedFingerprint: f.pin,
      }),
    /RELEASE_SIGNATURE_ENCODING_INVALID/,
  );
});

test("symlinked signed manifest is never followed", (t) => {
  const f = fixture(t);
  const [, revision] = REQUIRED_RELEASES[0];
  const file = path.join(f.dir, revision, "release-manifest.json");
  const moved = file + ".moved";
  fs.renameSync(file, moved);
  fs.symlinkSync(moved, file);
  assert.throws(
    () =>
      verifyAllReleaseSignatures({
        publicKeyPem: f.pem,
        releasesRoot: f.dir,
        expectedFingerprint: f.pin,
      }),
    /RELEASE_EVIDENCE_FILE_MISSING|RELEASE_EVIDENCE_FILE_UNTRUSTED/,
  );
});
test(
  "symlinked release directory is denied",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t);
    const [, revision] = REQUIRED_RELEASES[0];
    const dir = path.join(f.dir, revision);
    const moved = dir + ".moved";
    fs.renameSync(dir, moved);
    fs.symlinkSync(moved, dir, "dir");
    assert.throws(
      () =>
        verifyAllReleaseSignatures({
          publicKeyPem: f.pem,
          releasesRoot: f.dir,
          expectedFingerprint: f.pin,
        }),
      /RELEASE_DIRECTORY_UNTRUSTED/,
    );
  },
);

test("all ten releases are required, never a subset", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      verifyAllReleaseSignatures({
        publicKeyPem: f.pem,
        releasesRoot: f.dir,
        expectedFingerprint: f.pin,
        releases: REQUIRED_RELEASES.slice(0, 1),
      }),
    /RELEASE_SET_INVALID/,
  );
});

test("all ten committed release manifests and detached signatures are present", () => {
  // Structure/coverage only. This does NOT claim a real signing key was verified.
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../releases/stable",
  );
  for (const [sequence, revision] of REQUIRED_RELEASES) {
    const dir = path.join(root, revision);
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    const manifestFile = path.join(dir, "release-manifest.json");
    const signatureFile = path.join(dir, "release-manifest.sig");
    assert.equal(fs.lstatSync(manifestFile).isFile(), true);
    assert.equal(fs.lstatSync(signatureFile).isFile(), true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    assert.equal(manifest.sequence, sequence);
    assert.equal(manifest.revision, revision);
    assert.equal(manifest.keyId, "kmj-release-2026");
    assert.equal(manifest.channel, "stable");
    const signature = fs.readFileSync(signatureFile, "ascii").trim();
    assert.match(signature, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(Buffer.from(signature, "base64url").length, 64);
  }
});

test("owner-exported Ed25519 PEM verifies all ten real signed release manifests", () => {
  // Root-config PEM printed by the owner on 2026-11-15.
  // This repository fixture is NOT an independent live root-file custody proof.
  const base = path.dirname(fileURLToPath(import.meta.url));
  const publicKeyPem = fs.readFileSync(
    path.join(base, "fixtures/KMJ_RELEASE_PUBLIC_KEY_EVIDENCE_20261115.txt"),
    "utf8",
  );
  const verified = verifyAllReleaseSignatures({
    publicKeyPem,
    releasesRoot: path.resolve(base, "../releases/stable"),
  });
  assert.deepEqual(verified, {
    fingerprint:
      "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8",
    passed: 10,
    required: 10,
  });
});
