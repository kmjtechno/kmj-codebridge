import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  latestSignedRelease,
  PINNED_OWNER_SPKI_SHA256,
} from "../scripts/latest-signed-release.mjs";

// Ephemeral fixture keys are never production trust or owner signing material.
const fullSha = (c) => c.repeat(40);
function freshCatalog(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-signed-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const trustedSpkiSha256 = crypto
    .createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");

  function signed(dir, sequence, extra = {}) {
    const folder = path.join(root, dir);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const manifest = {
      schema: 1,
      product: "KMJ CodeBridge",
      channel: "stable",
      sequence,
      version: "0.3.2",
      revision: dir,
      archive:
        "https://kmjtechno.com/codebridge/releases/stable/" +
        dir +
        "/kmj-codebridge-0.3.2-" +
        dir.slice(0, 12) +
        ".tar.gz",
      sha256: "f".repeat(64),
      bytes: 102400,
      nodeMajor: 24,
      publishedAt: "2026-11-15T07:08:54.618Z",
      keyId: "kmj-release-2026",
      ...extra,
    };
    const raw = Buffer.from(JSON.stringify(manifest));
    const signature =
      crypto.sign(null, raw, privateKey).toString("base64url") + "\n";
    fs.writeFileSync(path.join(folder, "release-manifest.json"), raw, {
      mode: 0o644,
    });
    fs.writeFileSync(path.join(folder, "release-manifest.sig"), signature, {
      mode: 0o644,
    });
    return { folder, manifest, raw };
  }

  function resolve() {
    return latestSignedRelease(root, {
      trustedPublicKeyPem: publicKeyPem,
      trustedSpkiSha256,
    });
  }
  return { root, signed, resolve, privateKey, publicKeyPem, trustedSpkiSha256 };
}

test("highest valid OWNER SIGNED sequence wins, irrespective of readdir order", (t) => {
  const f = freshCatalog(t);
  f.signed(fullSha("a"), 23);
  f.signed(fullSha("b"), 26);
  f.signed(fullSha("0"), 25);
  assert.deepEqual(f.resolve(), { sequence: 26, revision: fullSha("b") });
});

test("an unsigned higher sequence does NOT override a valid lower signed release", (t) => {
  const f = freshCatalog(t);
  f.signed(fullSha("a"), 25);
  const x = f.signed(fullSha("b"), 999);
  fs.unlinkSync(path.join(x.folder, "release-manifest.sig"));
  assert.throws(f.resolve, /RELEASE_SIGNED_FILE_MISSING/);
});

test("tampered manifest or wrong signature rejected even with a lower valid sequence", (t) => {
  const f = freshCatalog(t);
  f.signed(fullSha("a"), 25);
  const x = f.signed(fullSha("b"), 26);
  fs.writeFileSync(
    path.join(x.folder, "release-manifest.json"),
    JSON.stringify({ ...x.manifest, sequence: 999 }),
  );
  assert.throws(f.resolve, /RELEASE_SIGNATURE_INVALID/);
});

test("different signing key or spoofed untrusted fingerprint is rejected", (t) => {
  const f = freshCatalog(t);
  f.signed(fullSha("a"), 25);
  const another = crypto
    .generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" });
  assert.throws(
    () =>
      latestSignedRelease(f.root, {
        trustedPublicKeyPem: another,
        trustedSpkiSha256: f.trustedSpkiSha256,
      }),
    /RELEASE_OWNER_KEY_UNTRUSTED/,
  );
  assert.notEqual(f.trustedSpkiSha256, PINNED_OWNER_SPKI_SHA256);
  assert.throws(
    () => latestSignedRelease(f.root),
    /RELEASE_OWNER_KEY_REQUIRED/,
  );
});

test("revision mismatch, duplicate signed sequence and empty catalog denied", (t) => {
  const x = freshCatalog(t);
  x.signed(fullSha("a"), 25, { revision: fullSha("b") });
  assert.throws(x.resolve, /RELEASE_REVISION_DIR_MISMATCH/);

  const y = freshCatalog(t);
  y.signed(fullSha("a"), 25);
  y.signed(fullSha("b"), 25);
  assert.throws(y.resolve, /RELEASE_SEQUENCE_DUPLICATE/);

  const z = freshCatalog(t);
  assert.throws(z.resolve, /RELEASE_NONE_VERIFIED/);
});

test("missing signature and malformed signature cannot be silently skipped", (t) => {
  const f = freshCatalog(t);
  const x = f.signed(fullSha("a"), 25);
  const sig = path.join(x.folder, "release-manifest.sig");
  fs.writeFileSync(sig, "not-a-base64url-signature\n");
  assert.throws(f.resolve, /RELEASE_SIGNATURE_SHAPE_INVALID/);
  fs.unlinkSync(sig);
  assert.throws(f.resolve, /RELEASE_SIGNED_FILE_MISSING/);
});

test("symlink manifest, signature and release directory denied without following", (t) => {
  const f = freshCatalog(t);
  const a = f.signed(fullSha("a"), 25);
  const manifest = path.join(a.folder, "release-manifest.json");
  fs.renameSync(manifest, manifest + ".actual");
  fs.symlinkSync(manifest + ".actual", manifest);
  assert.throws(f.resolve, /RELEASE_SIGNED_FILE_UNTRUSTED/);
  fs.unlinkSync(manifest);
  fs.renameSync(manifest + ".actual", manifest);
  const sig = path.join(a.folder, "release-manifest.sig");
  fs.renameSync(sig, sig + ".actual");
  fs.symlinkSync(sig + ".actual", sig);
  assert.throws(f.resolve, /RELEASE_SIGNED_FILE_UNTRUSTED/);
  fs.unlinkSync(sig);
  fs.renameSync(sig + ".actual", sig);
  fs.symlinkSync(a.folder, path.join(f.root, fullSha("b")), "dir");
  assert.throws(f.resolve, /RELEASE_DIRECTORY_UNTRUSTED/);
});

test("hardlinks and writable directories/files are denied", (t) => {
  const f = freshCatalog(t);
  const a = f.signed(fullSha("a"), 25);
  const target = path.join(a.folder, "release-manifest.json");
  fs.linkSync(target, path.join(a.folder, "duplicate"));
  assert.throws(f.resolve, /RELEASE_SIGNED_FILE_UNTRUSTED/);
  fs.unlinkSync(path.join(a.folder, "duplicate"));
  // Windows does not expose a reliable POSIX group/other mode contract.
  // The hardlink denial above is portable; mode checks are Linux-only.
  if (process.platform === "win32") return;
  fs.chmodSync(target, 0o666);
  assert.throws(f.resolve, /RELEASE_SIGNED_FILE_UNTRUSTED/);
  fs.chmodSync(target, 0o644);
  fs.chmodSync(a.folder, 0o777);
  assert.throws(f.resolve, /RELEASE_DIRECTORY_UNTRUSTED/);
});

test("malformed signed payload or unsupported key policy is blocked", (t) => {
  const f = freshCatalog(t);
  f.signed(fullSha("a"), 25, { channel: "preview" });
  assert.throws(f.resolve, /RELEASE_MANIFEST_SHAPE_INVALID/);
  const g = freshCatalog(t);
  g.signed(fullSha("a"), 25, { keyId: "malicious-new-key" });
  assert.throws(g.resolve, /RELEASE_MANIFEST_SHAPE_INVALID/);
  const h = freshCatalog(t);
  h.signed(fullSha("a"), 25, { archive: "https://evil.invalid/steal.tar.gz" });
  assert.throws(h.resolve, /RELEASE_MANIFEST_SHAPE_INVALID/);
});

test("signed rollback below an independently supplied floor is denied", (t) => {
  const f = freshCatalog(t);
  f.signed(fullSha("a"), 25);
  assert.throws(
    () =>
      latestSignedRelease(f.root, {
        trustedPublicKeyPem: f.publicKeyPem,
        trustedSpkiSha256: f.trustedSpkiSha256,
        minimumSequence: 26,
      }),
    /RELEASE_SEQUENCE_ROLLBACK/,
  );
  assert.throws(
    () =>
      latestSignedRelease(f.root, {
        trustedPublicKeyPem: f.publicKeyPem,
        trustedSpkiSha256: f.trustedSpkiSha256,
        minimumSequence: 0,
      }),
    /RELEASE_SEQUENCE_FLOOR_INVALID/,
  );
});

test("symlinked root ancestor is rejected even when signed files are valid", (t) => {
  const f = freshCatalog(t);
  f.signed(fullSha("a"), 25);
  const alias = path.join(
    path.dirname(f.root),
    "symlinked-signed-catalog-" + crypto.randomBytes(6).toString("hex"),
  );
  fs.symlinkSync(f.root, alias, "dir");
  t.after(() => fs.unlinkSync(alias));
  assert.throws(
    () =>
      latestSignedRelease(alias, {
        trustedPublicKeyPem: f.publicKeyPem,
        trustedSpkiSha256: f.trustedSpkiSha256,
      }),
    /RELEASE_ROOT_UNTRUSTED/,
  );
});

test("signed manifest doesn't count as installed, publicly accessible or restored", (t) => {
  const f = freshCatalog(t);
  f.signed(fullSha("a"), 25);
  const item = f.resolve();
  assert.deepEqual(Object.keys(item).sort(), ["revision", "sequence"]);
  assert.equal(item.sequence, 25);
  assert.ok(!("deployed" in item));
  assert.ok(!("archiveReachable" in item));
});

test("real repository without owner-provided trusted key fails closed", () => {
  assert.throws(() => latestSignedRelease(), /RELEASE_OWNER_KEY_REQUIRED/);
});

test("owner-exported public PEM verifies real signed stable release", () => {
  const trustedPublicKeyPem = fs.readFileSync(
    "tests/fixtures/KMJ_RELEASE_PUBLIC_KEY_EVIDENCE_20261115.txt",
    "utf8",
  );
  assert.deepEqual(
    latestSignedRelease("releases/stable", { trustedPublicKeyPem }),
    {
      sequence: 27,
      revision: "40655678db7fa62edca28ccc4988614010253ef1",
    },
  );
});
