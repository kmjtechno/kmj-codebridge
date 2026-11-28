import assert from "node:assert/strict";
import test from "node:test";
import {
  eliteOperationsCatalog,
  planEliteOperation,
} from "../src/elite-operations-plan.js";

const now = 1_000_000;
const candidateSha = "a".repeat(40);
const currentSha = "b".repeat(40);
const scope = {
  host: "kmj-elite",
  project: "kmj-main-platform",
  candidateSha,
  currentSha,
  now,
};
const production = eliteOperationsCatalog().find(
  (entry) => entry.profile === "production_deploy",
);
const observations = production.requiredEvidence.map((kind) => ({
  kind,
  host: scope.host,
  project: scope.project,
  candidateSha,
  currentSha,
  digest: "c".repeat(64),
  observedAt: now,
  status: "PASS",
}));

function plan(overrides = {}) {
  return planEliteOperation({
    ...scope,
    profile: production.profile,
    observations,
    ...overrides,
  });
}

test("catalog is fixed and grants no execution authority", () => {
  const catalog = eliteOperationsCatalog();
  assert.equal(catalog.length, 9);
  assert.ok(catalog.every((entry) => entry.executionEnabled === false));
  catalog[0].requiredEvidence.length = 0;
  assert.ok(eliteOperationsCatalog()[0].requiredEvidence.length > 0);
});

test("even complete production observations require independent host review", () => {
  const result = plan();
  assert.equal(result.status, "HOST_REVIEW_REQUIRED");
  assert.equal(result.ownerGrantRequired, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.operationAttempted, false);
});

test("missing rollback or authenticated QA evidence blocks readiness", () => {
  const result = plan({
    observations: observations.filter(
      (item) =>
        !["rollback_ready", "authenticated_qa_pass"].includes(item.kind),
    ),
  });
  assert.equal(result.status, "EVIDENCE_PENDING");
  assert.deepEqual(result.missing, ["authenticated_qa_pass", "rollback_ready"]);
});

test("arbitrary commands and non-Elite scope are rejected", () => {
  for (const overrides of [
    { profile: "constructor" },
    { host: "google-vps" },
    { project: "kmj-cloudos" },
    { command: "not-allowed" },
    { path: "/tmp" },
    { candidateSha: "main" },
  ]) {
    assert.equal(plan(overrides).status, "BLOCKED");
  }
});

test("stale, duplicate, foreign and mismatched evidence fails closed", () => {
  for (const change of [
    { observedAt: now - 120_001 },
    { observedAt: now + 1 },
    { project: "kmj-cloudos" },
    { candidateSha: currentSha },
    { currentSha: candidateSha },
    { digest: "unknown" },
    { status: "FAIL" },
  ]) {
    assert.equal(
      plan({ observations: [{ ...observations[0], ...change }] }).status,
      "BLOCKED",
    );
  }
  assert.equal(
    plan({ observations: [...observations, observations[0]] }).status,
    "BLOCKED",
  );
});
