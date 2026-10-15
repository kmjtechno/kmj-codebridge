import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyActionsJob,
  diagnoseActionsRun,
} from "../src/ci-execution-evidence.js";

const HEAD = "a".repeat(40);
const run = (conclusion = "failure", status = "completed") => ({
  id: 500,
  head_sha: HEAD,
  status,
  conclusion,
});
const job = (id, steps, status = "completed", conclusion = "failure") => ({
  id,
  name: "Laravel + TypeScript",
  steps,
  status,
  conclusion,
});

test("0-step failure does not masquerade as an application test failure", () => {
  const result = diagnoseActionsRun({
    run: run(),
    jobs: [job(12, []), job(13, [])],
    totalCount: 2,
    expectedHeadSha: HEAD,
  });
  assert.equal(result.classification, "FAILED_WITH_ZERO_JOB_STEPS");
  assert.equal(result.zeroStepFailedJobs, 2);
  assert.equal(result.evidenceComplete, true);
  assert.equal(result.codeTestsPassed, false);
  assert.equal(result.providerRootCauseVerified, false);
  assert.equal(result.localEvidenceIsHostedCi, false);
  assert.match(result.mergeAuthorization, /^BLOCKED/);
  assert.match(result.authorizedFallback, /ISOLATED_SHA_PINNED_WORKTREE/);
});

test("recorded steps show evidence of a job attempt, not proof that tests passed", () => {
  const result = diagnoseActionsRun({
    run: run(),
    jobs: [job(11, [{ name: "Set up job" }, { name: "Run tests" }])],
    totalCount: 1,
    expectedHeadSha: HEAD,
  });
  assert.equal(result.classification, "FAILED_WITH_RECORDED_STEPS");
  assert.equal(result.recordedStepJobs, 1);
  assert.equal(result.codeTestsPassed, false);
  assert.equal(result.jobs[0].applicationTestsVerified, false);
});

test("mixed zero-step and executed failures remain neither green nor test-pass", () => {
  const result = diagnoseActionsRun({
    run: run(),
    jobs: [job(10, []), job(11, [{ name: "Set up job" }])],
    totalCount: 2,
    expectedHeadSha: HEAD,
  });
  assert.equal(result.classification, "FAILED_MIXED_EXECUTION_EVIDENCE");
  assert.equal(result.zeroStepFailedJobs, 1);
});

test("missing step metadata is unknown, not zero-step", () => {
  const r = diagnoseActionsRun({
    run: run(),
    jobs: [job(5, undefined)],
    totalCount: 1,
    expectedHeadSha: HEAD,
  });
  assert.equal(r.zeroStepFailedJobs, 0);
  assert.equal(r.jobs[0].execution, "STEPS_UNKNOWN");
  assert.equal(r.classification, "OTHER_COMPLETED_STATE");
});

test("pagination and empty jobs cannot be construed as complete", () => {
  for (const [jobs, totalCount] of [[[], 0], [[job(1, [])], 2], [[job(1, [])], 101]]) {
    const r = diagnoseActionsRun({
      run: run(),
      jobs,
      totalCount,
      expectedHeadSha: HEAD,
    });
    assert.equal(r.classification, "INCOMPLETE_EVIDENCE");
    assert.equal(r.evidenceComplete, false);
  }
});

test("unknown or moved HEAD is rejected before any diagnostics are trusted", () => {
  assert.throws(() => diagnoseActionsRun({
    run: { ...run(), head_sha: "b".repeat(40) },
    jobs: [job(1, [])],
    totalCount: 1,
    expectedHeadSha: HEAD,
  }), /CI_HEAD_MISMATCH/);
  assert.throws(() => diagnoseActionsRun({
    run: run(),
    jobs: [job(1, [])],
    totalCount: 1,
    expectedHeadSha: "a",
  }), /CI_HEAD_MISMATCH/);
});

test("pending and provider-success reports do not authorize merge", () => {
  const pending = diagnoseActionsRun({
    run: run(null, "queued"),
    jobs: [job(1, [], "queued", null)],
    totalCount: 1,
    expectedHeadSha: HEAD,
  });
  assert.equal(pending.classification, "RUN_PENDING");
  const success = diagnoseActionsRun({
    run: run("success"),
    jobs: [job(2, [{ name: "tests" }], "completed", "success")],
    totalCount: 1,
    expectedHeadSha: HEAD,
  });
  assert.equal(success.classification, "SUCCESS_REQUIRES_FULL_PR_GATES");
  assert.equal(success.codeTestsPassed, false);
  assert.match(success.mergeAuthorization, /^BLOCKED/);
});

test("bad job identity cannot authorize a complete diagnosis", () => {
  const r = diagnoseActionsRun({
    run: run(),
    jobs: [{ ...job(3, []), id: "bad" }],
    totalCount: 1,
    expectedHeadSha: HEAD,
  });
  assert.equal(r.evidenceComplete, false);
  assert.equal(r.jobs[0].id, null);
  assert.equal(r.classification, "INCOMPLETE_EVIDENCE");
  assert.equal(classifyActionsJob({ steps: null, status: "completed" }).recordedStepCount, null);
});
