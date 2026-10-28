import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { buildSignedReleaseManifest } from "../scripts/sign-runtime-manifest.js";
import { verifySignedReleaseBundle } from "../scripts/verify-signed-bundle.mjs";
import { tryFileSymlink } from "./windows-symlink-capability.js";

const REV = "a".repeat(40);
const NAME = "kmj-codebridge-0.3.2-" + REV.slice(0, 12) + ".tar.gz";

function fixture(t, channel = "beta") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-signed-bundle-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const archive = Buffer.from(
    "synthetic archive content for offline digest test",
  );
  const runtime = {
    product: "KMJ CodeBridge",
    version: "0.3.2",
    format: "source-runtime",
    signed: false,
    revision: REV,
    archive: NAME,
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
  };
  const ownerKey = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const signed = buildSignedReleaseManifest({
    runtimeManifest: runtime,
    archiveUrl:
      "https://kmjtechno.com/codebridge/releases/" + channel + "/" + REV + "/" + NAME,
    sequence: 12,
    keyId: "owner-2026",
    privateKeyPem: ownerKey,
    channel,
    publishedAt: "2026-10-17T00:00:00Z",
  });
  const write = (name, bytes) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
  const options = {
    signedManifestPath: write("release-manifest.json", signed.manifestBytes),
    signaturePath: write("release-manifest.sig", signed.signature + "\n"),
    trustedKeysPath: write(
      "trusted-keys.json",
      JSON.stringify({ "owner-2026": publicPem }),
    ),
    runtimeManifestPath: write(
      "runtime-manifest.json",
      JSON.stringify(runtime),
    ),
    archivePath: write(NAME, archive),
    minimumSequence: 11,
  };
  return { options, runtime, signed, dir, publicPem, write };
}

test("verifies exact owner Ed25519 signature and streamed source archive SHA-256", async (t) => {
  const { options, runtime } = fixture(t);
  const output = await verifySignedReleaseBundle(options);
  assert.equal(output.verdict, "CRYPTOGRAPHICALLY_VERIFIED");
  assert.equal(output.sequence, 12);
  assert.equal(output.revision, REV);
  assert.equal(output.archiveSha256, runtime.sha256);
  assert.equal(output.archiveBytes, runtime.bytes);
  assert.match(output.note, /No network, CI/);
});

test("rejects malicious archive-byte substitution even when manifest is signed", async (t) => {
  const { options } = fixture(t);
  fs.writeFileSync(options.archivePath, "X".repeat(49));
  await assert.rejects(
    verifySignedReleaseBundle(options),
    /BUNDLE_ARCHIVE_SIZE_MISMATCH|BUNDLE_ARCHIVE_SHA256_MISMATCH/,
  );
});

test("rejects a forged signature and unknown signing key", async (t) => {
  const { options, write } = fixture(t);
  fs.writeFileSync(
    options.signaturePath,
    Buffer.alloc(64, 12).toString("base64url"),
  );
  await assert.rejects(
    verifySignedReleaseBundle(options),
    /UPDATE_SIGNATURE_INVALID/,
  );
  options.signaturePath = write("release-manifest-unknown.sig", "garbage");
  await assert.rejects(
    verifySignedReleaseBundle(options),
    /UPDATE_SIGNATURE_INVALID/,
  );
});

test("rejects a mismatched runtime revision despite valid signed manifest", async (t) => {
  const { options, runtime } = fixture(t);
  fs.writeFileSync(
    options.runtimeManifestPath,
    JSON.stringify({ ...runtime, revision: "b".repeat(40) }),
  );
  await assert.rejects(
    verifySignedReleaseBundle(options),
    /BUNDLE_MANIFEST_IDENTITY_MISMATCH/,
  );
});

test("rejects stale sequence and invalid minimumSequence", async (t) => {
  const { options } = fixture(t);
  await assert.rejects(
    verifySignedReleaseBundle({ ...options, minimumSequence: 12 }),
    /UPDATE_ROLLBACK_REJECTED/,
  );
  await assert.rejects(
    verifySignedReleaseBundle({ ...options, minimumSequence: -2 }),
    /BUNDLE_MINIMUM_SEQUENCE_INVALID/,
  );
});

test("rejects symlinks for archive or signing inputs", async (t) => {
  const { options, dir } = fixture(t);
  const link = path.join(dir, "signed-manifest-link.json");
  if (!tryFileSymlink(t, options.signedManifestPath, link)) {
    t.skip(
      "Windows cannot create symlink fixture; security assertion NOT EXECUTED",
    );
    return;
  }
  await assert.rejects(
    verifySignedReleaseBundle({ ...options, signedManifestPath: link }),
    /BUNDLE_FILE_UNSAFE/,
  );
  const archiveLink = path.join(dir, "archive-link.tar.gz");
  if (!tryFileSymlink(t, options.archivePath, archiveLink)) {
    t.skip(
      "Windows cannot create symlink fixture; security assertion NOT EXECUTED",
    );
    return;
  }
  await assert.rejects(
    verifySignedReleaseBundle({ ...options, archivePath: archiveLink }),
    /BUNDLE_MANIFEST_IDENTITY_MISMATCH|BUNDLE_FILE_UNSAFE/,
  );
});

test("requires PUBLIC keys, never private PEM or an untrusted key", async (t) => {
  const { options } = fixture(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(
    options.trustedKeysPath,
    JSON.stringify({
      "owner-2026": privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  await assert.rejects(
    verifySignedReleaseBundle(options),
    /BUNDLE_TRUSTED_KEYS_INVALID/,
  );
  fs.writeFileSync(
    options.trustedKeysPath,
    JSON.stringify({
      "owner-2026": publicKey.export({ type: "spki", format: "pem" }),
    }),
  );
  await assert.rejects(
    verifySignedReleaseBundle(options),
    /UPDATE_SIGNATURE_INVALID/,
  );
});

test("invalid manifest JSON and missing files fail closed", async (t) => {
  const { options } = fixture(t);
  fs.writeFileSync(options.runtimeManifestPath, "{ broken");
  await assert.rejects(
    verifySignedReleaseBundle(options),
    /BUNDLE_JSON_INVALID/,
  );
  await assert.rejects(
    verifySignedReleaseBundle({
      ...options,
      trustedKeysPath: "/definitely/not/available.json",
    }),
    /BUNDLE_FILE_UNAVAILABLE/,
  );
});


test("stable promotion requires explicitly signed stable channel, not trusted beta", async (t) => {
  const { options } = fixture(t);
  await assert.rejects(
    verifySignedReleaseBundle({ ...options, expectedChannel: "stable" }),
    /BUNDLE_CHANNEL_MISMATCH/,
  );
  const beta = await verifySignedReleaseBundle({ ...options, expectedChannel: "beta" });
  assert.equal(beta.channel, "beta");
});

test("stable candidate can pass explicit stable-channel gate with valid signature", async (t) => {
  const { options } = fixture(t, "stable");
  const result = await verifySignedReleaseBundle({ ...options, expectedChannel: "stable" });
  assert.equal(result.verdict, "CRYPTOGRAPHICALLY_VERIFIED");
  assert.equal(result.channel, "stable");
  await assert.rejects(
    verifySignedReleaseBundle({ ...options, expectedChannel: "beta" }),
    /BUNDLE_CHANNEL_MISMATCH/,
  );
});

test("invalid explicit channel fails closed", async (t) => {
  const { options } = fixture(t);
  for (const channel of ["gamma", ""]) {
    await assert.rejects(
      verifySignedReleaseBundle({ ...options, expectedChannel: channel }),
      /BUNDLE_EXPECTED_CHANNEL_INVALID/,
    );
  }
});
