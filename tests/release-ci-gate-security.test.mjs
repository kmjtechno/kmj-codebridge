import assert from "node:assert/strict";
import test from "node:test";
import {
  assessReleaseChecks,
  REQUIRED_RELEASE_CHECKS,
} from "../scripts/release-ci-gate.mjs";

const SHA = "9584b584c9a94545fb9dc750c9dfef5bf4f7978a";
const good = (name) => ({
  name,
  head_sha: SHA,
  app: { slug: "github-actions" },
  status: "completed",
  conclusion: "success",
});
const response = (runs) => ({ total_count: runs.length, check_runs: runs });
const required = () => REQUIRED_RELEASE_CHECKS.map(good);

test("all five distinct exact-head successful GitHub Actions checks admit", () => {
  assert.equal(assessReleaseChecks(response(required()), SHA).ready, true);
});

test("a second successful required check fails closed rather than counting as a quorum", () => {
  const result = assessReleaseChecks(
    response([...required(), good(REQUIRED_RELEASE_CHECKS[0])]),
    SHA,
  );
  assert.deepEqual(result, {
    ready: false,
    reason: "CI_REQUIRED_NAME_MISSING_OR_DUPLICATED",
  });
});

test("an extra failed or foreign-SHA check cannot be hidden by five passing checks", () => {
  for (const extra of [
    { ...good("other"), conclusion: "failure" },
    { ...good("other"), head_sha: "a".repeat(40) },
    { ...good("other"), app: { slug: "untrusted-app" } },
  ]) {
    assert.equal(
      assessReleaseChecks(response([...required(), extra]), SHA).ready,
      false,
    );
  }
});

test("missing, pending, and cross-commit required checks all fail closed", () => {
  const cases = [
    required().slice(1),
    required().map((run, i) =>
      i === 0 ? { ...run, status: "in_progress", conclusion: null } : run,
    ),
    required().map((run, i) =>
      i === 0 ? { ...run, head_sha: "b".repeat(40) } : run,
    ),
  ];
  for (const runs of cases) {
    assert.equal(assessReleaseChecks(response(runs), SHA).ready, false);
  }
});

test("inconsistent or unbounded response counts cannot authorize release", () => {
  for (const body of [
    { total_count: 5, check_runs: required().slice(1) },
    { total_count: 101, check_runs: required() },
    { total_count: 5.5, check_runs: required() },
    { total_count: 5, check_runs: {} },
  ]) {
    assert.equal(assessReleaseChecks(body, SHA).ready, false);
  }
});

test("signed publication alone is not a substitute for source CI", () => {
  const runs = [good("signed_release"), ...required().slice(1)];
  assert.equal(assessReleaseChecks(response(runs), SHA).ready, false);
});
