import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  buildSignedReleaseManifest,
} from "../scripts/sign-runtime-manifest.js";
import { verifyReleaseManifest } from "../src/update.js";

function runtimeManifest() {
  return {
    product: "KMJ CodeBridge",
    version: "0.2.0",
    revision: "a".repeat(40),
    archive: "kmj-codebridge-0.2.0-aaaaaaaaaaaa.tar.gz",
    bytes: 1234,
    sha256: "b".repeat(64),
    format: "source-runtime",
    requires: "Node.js 24; npm ci --ignore-scripts",
    signed: false,
  };
}

test("build-host signer emits a manifest accepted by runtime verification", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signed = buildSignedReleaseManifest({
    runtimeManifest: runtimeManifest(),
    archiveUrl:
      "https://releases.kmjtechno.com/codebridge/kmj-codebridge-0.2.0-aaaaaaaaaaaa.tar.gz",
    sequence: 42,
    keyId: "release-2026",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publishedAt: "2026-10-03T00:00:00Z",
  });
  const verified = verifyReleaseManifest(
    signed.manifestBytes,
    signed.signature,
    {
      "release-2026": publicKey.export({ type: "spki", format: "pem" }),
    },
    { minimumSequence: 41 },
  );
  assert.equal(verified.sequence, 42);
  assert.equal(verified.version, "0.2.0");
});

test("signer rejects a runtime archive URL that does not match the packaged archive", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      buildSignedReleaseManifest({
        runtimeManifest: runtimeManifest(),
        archiveUrl:
          "https://releases.kmjtechno.com/codebridge/different.tar.gz",
        sequence: 42,
        keyId: "release-2026",
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
        publishedAt: "2026-10-03T00:00:00Z",
      }),
    /UPDATE_ARCHIVE_URL_MISMATCH/,
  );
});
