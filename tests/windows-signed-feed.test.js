import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  inspectWindowsSignedFeed,
  planVerifiedWindowsRelease,
} from "../src/windows-signed-feed.js";

const current = "a".repeat(40);
const next = "b".repeat(40);
const accepted = { sequence: 42, revision: current };
const state = { accepted, runningRevision: current, nodeMajor: 24 };

function manifest(sequence = 43, revision = next) {
  return {
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
    sha256: "c".repeat(64),
    bytes: 2048,
    nodeMajor: 24,
    publishedAt: "2026-11-28T07:28:16.932Z",
    keyId: "kmj-release-2026",
  };
}

test("newer verified release is a candidate, never activation evidence", () => {
  const result = planVerifiedWindowsRelease(manifest(), state);
  assert.equal(result.state, "NEW_SIGNED_RELEASE_CANDIDATE");
  assert.equal(result.sequence, 43);
  assert.equal(result.revision, next);
  assert.equal(result.activationAttempted, false);
  assert.equal(result.archiveVerified, false);
  assert.equal(result.healthyActivationVerified, false);
});

test("same sequence is current only for the identical accepted revision", () => {
  assert.equal(
    planVerifiedWindowsRelease(manifest(42, current), state).state,
    "CURRENT_ACCEPTED_REVISION",
  );
  assert.throws(
    () => planVerifiedWindowsRelease(manifest(42), state),
    /WINDOWS_UPDATE_SEQUENCE_COLLISION/,
  );
  assert.throws(
    () => planVerifiedWindowsRelease(manifest(41, current), state),
    /WINDOWS_UPDATE_SEQUENCE_REPLAY/,
  );
});

test("untrusted or rolled-back runtime must reconcile before any update", () => {
  for (const baseline of [null, { sequence: 0, revision: current }]) {
    assert.throws(
      () =>
        planVerifiedWindowsRelease(manifest(), {
          ...state,
          accepted: baseline,
        }),
      /WINDOWS_UPDATE_TRUSTED_BASELINE_REQUIRED/,
    );
  }
  assert.throws(
    () =>
      planVerifiedWindowsRelease(manifest(), {
        ...state,
        runningRevision: next,
      }),
    /WINDOWS_UPDATE_BASELINE_RECONCILIATION_REQUIRED/,
  );
});

test("reject alternate feed, channel, key and Node runtime", () => {
  for (const change of [
    { archive: manifest().archive.replace("kmjtechno.com", "example.com") },
    { channel: "beta" },
    { keyId: "other" },
  ]) {
    assert.throws(
      () => planVerifiedWindowsRelease({ ...manifest(), ...change }, state),
      /WINDOWS_UPDATE_CHANNEL_OR_RUNTIME_REJECTED/,
    );
  }
  assert.throws(
    () =>
      planVerifiedWindowsRelease(manifest(), {
        ...state,
        nodeMajor: 22,
      }),
    /WINDOWS_UPDATE_CHANNEL_OR_RUNTIME_REJECTED/,
  );
});

test("non-owner key is rejected locally before any feed request", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  await assert.rejects(
    inspectWindowsSignedFeed({
      accepted,
      runningRevision: current,
      trustedPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    }),
    /WINDOWS_UPDATE_OWNER_KEY_UNTRUSTED/,
  );
});
