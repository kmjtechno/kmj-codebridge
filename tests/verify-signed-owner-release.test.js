import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  generateKeyPairSync,
  createHash,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  verifyOwnerSignedPair,
  verifyOwnerReleaseFolder,
  OWNER_SPKI_SHA256,
} from "../scripts/verify-signed-owner-release.mjs";

const REV = "a".repeat(40);
const manifest = () => ({
  schema: 1,
  product: "KMJ CodeBridge",
  channel: "stable",
  sequence: 32,
  version: "0.3.2",
  revision: REV,
  archive:
    "https://kmjtechno.com/codebridge/releases/stable/" +
    REV +
    "/kmj-codebridge-0.3.2-" +
    REV.slice(0, 12) +
    ".tar.gz",
  sha256: "b".repeat(64),
  bytes: 1024,
  nodeMajor: 24,
  publishedAt: "2026-11-18T08:00:00.000Z",
  keyId: "kmj-release-2026",
});

test("detached signature must be verified over exact raw manifest bytes", () => {
  const one = generateKeyPairSync("ed25519");
  const two = generateKeyPairSync("ed25519");
  const pem = one.publicKey.export({ type: "spki", format: "pem" });
  const fp = createHash("sha256")
    .update(one.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const bytes = Buffer.from(JSON.stringify(manifest(), null, 2) + "\n");
  const sig = Buffer.from(
    sign(null, bytes, one.privateKey).toString("base64url") + "\n",
  );
  const good = {
    manifestBytes: bytes,
    signatureBytes: sig,
    publicKeyPem: pem,
    revision: REV,
    expectedSpki: fp,
  };
  assert.equal(verifyOwnerSignedPair(good).sequence, 32);
  assert.throws(
    () =>
      verifyOwnerSignedPair({
        ...good,
        expectedSpki: OWNER_SPKI_SHA256,
      }),
    /OWNER_RELEASE_SPKI_MISMATCH/,
  );
  assert.throws(
    () =>
      verifyOwnerSignedPair({
        ...good,
        publicKeyPem: two.publicKey.export({ type: "spki", format: "pem" }),
      }),
    /OWNER_RELEASE_SPKI_MISMATCH/,
  );
  assert.throws(
    () =>
      verifyOwnerSignedPair({
        ...good,
        revision: "c".repeat(40),
      }),
    /OWNER_RELEASE_IDENTITY_INVALID/,
  );
  assert.throws(
    () =>
      verifyOwnerSignedPair({
        ...good,
        manifestBytes: Buffer.from(
          bytes.toString("utf8").replace('"sequence": 32', '"sequence": 33'),
        ),
      }),
    /OWNER_RELEASE_SIGNATURE_INVALID/,
  );
  assert.throws(
    () =>
      verifyOwnerSignedPair({
        ...good,
        signatureBytes: Buffer.from("A".repeat(85) + "*"),
      }),
    /OWNER_RELEASE_SIGNATURE_FORMAT_INVALID/,
  );
  assert.throws(
    () =>
      verifyOwnerSignedPair({
        ...good,
        signatureBytes: Buffer.from(""),
      }),
    /OWNER_RELEASE_BYTES_INVALID/,
  );
});

test("real owner-proven public fixture verifies an existing genuine release", () => {
  const fixture = fs.readFileSync(
    "tests/fixtures/KMJ_RELEASE_PUBLIC_KEY_EVIDENCE_20261115.txt",
  );
  const publicKey = createPublicKey(fixture);
  const fp = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  assert.equal(fp, OWNER_SPKI_SHA256);
  // Seq15 is a committed, immutable owner signature, not a synthetic key.
  const revision = "1d216841f9b2a3aaa80fa42d6a24ab62fd23da2f";
  const actual = verifyOwnerReleaseFolder(process.cwd(), revision);
  assert.equal(actual.revision, revision);
  assert.equal(actual.sequence, 15);
});

test("CLI blocks malformed or missing revisions without exposing signing material", () => {
  const noSha = spawnSync("node", ["scripts/verify-signed-owner-release.mjs"], {
    encoding: "utf8",
  });
  assert.equal(noSha.status, 2);
  assert.match(noSha.stderr, /OWNER_RELEASE_ED25519=BLOCKED/);
  const wrong = spawnSync(
    "node",
    ["scripts/verify-signed-owner-release.mjs", REV],
    { encoding: "utf8" },
  );
  assert.equal(wrong.status, 2);
  assert.doesNotMatch(wrong.stderr, /BEGIN PUBLIC KEY|PRIVATE KEY/);
});

test("GitHub Release publication requires independent owner Ed25519 proof", () => {
  const wf = fs.readFileSync(
    ".github/workflows/publish-signed-stable.yml",
    "utf8",
  );
  assert.match(
    wf,
    /node scripts\/verify-signed-owner-release\.mjs "\$REVISION"/,
  );
  assert.match(wf, /id: owner_signature/);
  assert.match(wf, /steps\.owner_signature\.outcome == 'success'/);
  assert.match(wf, /github\.event_name != 'pull_request'/);
  assert.match(wf, /gh release create/);
  assert.doesNotMatch(wf, /continue-on-error:\s*true/);
});
