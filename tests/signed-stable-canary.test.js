import assert from "node:assert/strict";
import { test } from "node:test";
import { assessSignedStableCanary } from "../scripts/production/assess-signed-stable-canary.mjs";
import { verifySignedStableCanary } from "../scripts/production/verify-signed-stable-canary.mjs";

const oldSha = "2d713aa9aa9a0641f0591ff6c881df62d68bfd22";
const newSha = "8f31e9140f29914ee2a1e7c465da842394bad122";
const archiveSha = "a".repeat(64);
const approvalDigest = "b".repeat(64);
const sample = () => ({
  expectedSha: newSha,
  bundle: {
    verdict: "CRYPTOGRAPHICALLY_VERIFIED",
    signatureAlgorithm: "Ed25519",
    archiveAlgorithm: "SHA-256",
    channel: "stable",
    revision: newSha,
    archiveSha256: archiveSha,
    archiveBytes: 1024,
    sequence: 24,
  },
  runtime: {
    activeSha: oldSha,
    activeRelease: `0.3.2-${oldSha.slice(0, 12)}`,
    gatewayActive: true,
    agentActive: true,
    signedUpdaterInstalled: true,
    fixedOperatorUnitAttested: true,
    gatewayConfigVerified: true,
    acceptedSequence: 23,
  },
  operator: {
    stagedSha: newSha,
    stagedArchiveSha256: archiveSha,
    stagedSequence: 24,
    approvalDigest,
    ownerApprovalVerified: true,
    rollbackTarget: `0.3.2-${oldSha.slice(0, 12)}`,
    rollbackDrillVerified: true,
    stagingHealthVerified: true,
    unitPolicyVerified: true,
  },
});

function blocked(mutator, code) {
  const input = sample();
  mutator(input);
  const result = assessSignedStableCanary(input);
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(result.activationAuthorized, false);
  assert.equal(result.productionLive, false);
  assert.ok(result.blockers.includes(code), result.blockers.join(","));
}

test("complete assertions never authorize activation or claim live", () => {
  const result = assessSignedStableCanary(sample());
  assert.equal(result.verdict, "READY_FOR_PROTECTED_OWNER_REVIEW");
  assert.equal(result.activationAuthorized, false);
  assert.equal(result.productionLive, false);
});

test("missing evidence fails closed", () => {
  const result = assessSignedStableCanary();
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.blockers.length >= 4);
});

test("unsigned, beta, stale or wrong SHA cannot qualify", () => {
  blocked((v) => {
    v.bundle.verdict = "CLAIMED";
  }, "SIGNED_STABLE_BUNDLE_NOT_VERIFIED");
  blocked((v) => {
    v.bundle.channel = "beta";
  }, "SIGNED_STABLE_BUNDLE_NOT_VERIFIED");
  blocked((v) => {
    v.bundle.revision = oldSha;
  }, "EXACT_SOURCE_SHA_MISMATCH");
  blocked((v) => {
    v.expectedSha = "invalid";
  }, "EXACT_SOURCE_SHA_MISMATCH");
});

test("old runtime, missing protected updater and unsafe config block", () => {
  blocked((v) => {
    v.runtime.activeSha = newSha;
  }, "CURRENT_RUNTIME_IDENTITY_UNVERIFIED");
  blocked((v) => {
    v.runtime.activeRelease = "0.3.2-fake";
  }, "CURRENT_RUNTIME_IDENTITY_UNVERIFIED");
  blocked((v) => {
    v.runtime.gatewayActive = false;
  }, "CURRENT_RUNTIME_IDENTITY_UNVERIFIED");
  blocked((v) => {
    v.runtime.fixedOperatorUnitAttested = false;
  }, "PROTECTED_OPERATOR_PATH_UNVERIFIED");
  blocked((v) => {
    v.runtime.gatewayConfigVerified = false;
  }, "PROTECTED_OPERATOR_PATH_UNVERIFIED");
});

test("sequence must advance and owner staging/rollback receipts match", () => {
  blocked((v) => {
    v.runtime.acceptedSequence = 24;
  }, "ANTI_ROLLBACK_SEQUENCE_UNVERIFIED");
  blocked((v) => {
    v.runtime.acceptedSequence = -1;
  }, "ANTI_ROLLBACK_SEQUENCE_UNVERIFIED");
  blocked((v) => {
    v.operator.stagedSha = oldSha;
  }, "OWNER_STAGING_ROLLBACK_RECEIPTS_MISSING");
  blocked((v) => {
    v.operator.stagedArchiveSha256 = "c".repeat(64);
  }, "OWNER_STAGING_ROLLBACK_RECEIPTS_MISSING");
  blocked((v) => {
    v.operator.rollbackTarget = "0.3.2-000000000000";
  }, "OWNER_STAGING_ROLLBACK_RECEIPTS_MISSING");
  blocked((v) => {
    v.operator.ownerApprovalVerified = false;
  }, "OWNER_STAGING_ROLLBACK_RECEIPTS_MISSING");
  blocked((v) => {
    v.operator.rollbackDrillVerified = false;
  }, "OWNER_STAGING_ROLLBACK_RECEIPTS_MISSING");
});

test("observed real ELITE blockers do not qualify", () => {
  const v = sample();
  v.runtime.fixedOperatorUnitAttested = false;
  v.runtime.gatewayConfigVerified = false;
  v.operator.ownerApprovalVerified = false;
  v.operator.rollbackDrillVerified = false;
  const result = assessSignedStableCanary(v);
  assert.equal(result.verdict, "BLOCKED");
  assert.deepEqual(result.blockers, [
    "PROTECTED_OPERATOR_PATH_UNVERIFIED",
    "OWNER_STAGING_ROLLBACK_RECEIPTS_MISSING",
  ]);
});

test("cryptographic entry point rejects missing protected sequence", async () => {
  await assert.rejects(
    verifySignedStableCanary({ runtime: { acceptedSequence: -1 } }),
    /STABLE_CANARY_INPUT_INVALID/,
  );
  await assert.rejects(
    verifySignedStableCanary({ runtime: { acceptedSequence: 0 } }),
    /STABLE_CANARY_INPUT_INVALID/,
  );
});
