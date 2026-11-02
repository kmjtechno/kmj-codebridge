import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifySignedStableCanary } from "../scripts/production/verify-signed-stable-canary.mjs";

test("real Ed25519 stable bundle binds SHA, sequence, archive and owner gate", async () => {
  const oldSha = "2d713aa9aa9a0641f0591ff6c881df62d68bfd22";
  const newSha = "8f31e9140f29914ee2a1e7c465da842394bad122";
  const archiveName = `kmj-codebridge-0.3.2-${newSha.slice(0, 12)}.tar.gz`;
  const archive = Buffer.from("isolated-test-archive");
  const digest = createHash("sha256").update(archive).digest("hex");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-stable-canary-"));
  const file = (name) => path.join(root, name);
  const bundlePaths = {
    signedManifestPath: file("release-manifest.json"),
    signaturePath: file("release-manifest.sig"),
    trustedKeysPath: file("trusted-keys.json"),
    runtimeManifestPath: file("runtime-manifest.json"),
    archivePath: file(archiveName),
  };
  const manifest = {
    schema: 1,
    product: "KMJ CodeBridge",
    channel: "stable",
    sequence: 24,
    version: "0.3.2",
    revision: newSha,
    archive: `https://releases.kmjtechno.com/${archiveName}`,
    sha256: digest,
    bytes: archive.length,
    nodeMajor: 24,
    publishedAt: "2026-11-02T00:00:00.000Z",
    keyId: "test-only",
  };
  const writeSigned = () => {
    const bytes = Buffer.from(JSON.stringify(manifest) + "\n");
    fs.writeFileSync(bundlePaths.signedManifestPath, bytes);
    fs.writeFileSync(
      bundlePaths.signaturePath,
      sign(null, bytes, privateKey).toString("base64url"),
    );
  };
  const runtime = {
    activeSha: oldSha,
    activeRelease: `0.3.2-${oldSha.slice(0, 12)}`,
    gatewayActive: true,
    agentActive: true,
    signedUpdaterInstalled: true,
    fixedOperatorUnitAttested: true,
    gatewayConfigVerified: true,
    acceptedSequence: 23,
  };
  const operator = {
    stagedSha: newSha,
    stagedArchiveSha256: digest,
    stagedSequence: 24,
    approvalDigest: "a".repeat(64),
    ownerApprovalVerified: true,
    rollbackTarget: runtime.activeRelease,
    rollbackDrillVerified: true,
    stagingHealthVerified: true,
    unitPolicyVerified: true,
  };
  const verify = () =>
    verifySignedStableCanary({
      bundlePaths,
      expectedSha: newSha,
      runtime,
      operator,
    });

  try {
    fs.writeFileSync(bundlePaths.archivePath, archive);
    fs.writeFileSync(
      bundlePaths.trustedKeysPath,
      JSON.stringify({
        "test-only": publicKey.export({ type: "spki", format: "pem" }),
      }),
    );
    fs.writeFileSync(
      bundlePaths.runtimeManifestPath,
      JSON.stringify({
        product: "KMJ CodeBridge",
        format: "source-runtime",
        signed: false,
        version: manifest.version,
        revision: manifest.revision,
        archive: archiveName,
        sha256: digest,
        bytes: archive.length,
      }),
    );
    writeSigned();
    const valid = await verify();
    assert.equal(valid.verdict, "READY_FOR_PROTECTED_OWNER_REVIEW");
    assert.equal(valid.activationAuthorized, false);
    assert.equal(valid.productionLive, false);

    runtime.acceptedSequence = 24;
    await assert.rejects(verify(), /UPDATE_ROLLBACK_REJECTED/);
    runtime.acceptedSequence = 23;

    fs.writeFileSync(bundlePaths.signaturePath, "invalid-signature");
    await assert.rejects(verify());
    writeSigned();

    fs.writeFileSync(bundlePaths.archivePath, Buffer.alloc(archive.length));
    await assert.rejects(verify(), /BUNDLE_ARCHIVE_SHA256_MISMATCH/);
    fs.writeFileSync(bundlePaths.archivePath, archive);

    manifest.channel = "beta";
    writeSigned();
    await assert.rejects(verify(), /BUNDLE_CHANNEL_MISMATCH/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
