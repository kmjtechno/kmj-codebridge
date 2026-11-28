import assert from "node:assert/strict";
import test from "node:test";
import {
  signingPolicyHealth,
  summarizeEliteReadback,
} from "../src/elite-operations-readback.js";

const candidateSha = "a".repeat(40);
const healthy = {
  candidateSha,
  staging: {
    approvedSha: candidateSha,
    currentSha: candidateSha,
    productionUnchanged: true,
  },
  production: {
    approvedSha: candidateSha,
    nginxActive: true,
    phpFpmActive: true,
    readyToActivate: true,
  },
  maintenance: { recentBackupVerified: true, restoreVerified: true },
};

test("production ready does not override staging drift or missing receipts", () => {
  const result = summarizeEliteReadback({
    ...healthy,
    staging: {
      approvedSha: "b".repeat(40),
      currentSha: "c".repeat(40),
      productionUnchanged: false,
    },
    maintenance: { recentBackupVerified: false, restoreVerified: false },
  });
  assert.equal(result.status, "BLOCKED_OR_UNKNOWN");
  assert.deepEqual(result.blockers, [
    "STAGING_CANDIDATE_UNVERIFIED",
    "STAGING_PRODUCTION_CONTINUITY_UNVERIFIED",
    "BACKUP_UNVERIFIED",
    "RESTORE_UNVERIFIED",
  ]);
  assert.equal(result.executionAuthorized, false);
});

test("complete readback is still not approval or authenticated QA", () => {
  const result = summarizeEliteReadback(healthy);
  assert.equal(result.status, "HOST_REVIEW_REQUIRED");
  assert.equal(result.authenticatedQaVerified, false);
  assert.equal(result.deploymentVerified, false);
  assert.equal(result.executionAuthorized, false);
});

test("missing readback cannot be green", () => {
  assert.equal(summarizeEliteReadback().status, "BLOCKED_OR_UNKNOWN");
});

const policy = {
  verified: true,
  maxSequence: 100,
  latestSequence: 43,
  now: 1_000_000,
  expiresAt: 1_000_000 + 20 * 86_400_000,
};

test("owner policy warns before sequence or expiry exhaustion", () => {
  assert.equal(signingPolicyHealth(policy).status, "HEADROOM_AVAILABLE");
  assert.equal(
    signingPolicyHealth({ ...policy, latestSequence: 95 }).status,
    "RENEWAL_RECOMMENDED",
  );
  assert.equal(
    signingPolicyHealth({ ...policy, expiresAt: policy.now + 1 }).status,
    "RENEWAL_RECOMMENDED",
  );
});

test("exhausted, expired or unverified policies cannot authorize signing", () => {
  const exhausted = signingPolicyHealth({ ...policy, latestSequence: 100 });
  assert.equal(exhausted.status, "SEQUENCE_POLICY_EXHAUSTED");
  assert.equal(exhausted.remaining, 0);
  assert.equal(exhausted.ownerRenewalRequired, true);
  assert.equal(exhausted.signingAuthorized, false);
  assert.equal(
    signingPolicyHealth({ ...policy, expiresAt: policy.now }).status,
    "POLICY_EXPIRED",
  );
  assert.equal(
    signingPolicyHealth({ ...policy, verified: false }).status,
    "POLICY_UNKNOWN",
  );
});
