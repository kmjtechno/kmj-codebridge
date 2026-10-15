import assert from "node:assert/strict";
import { test } from "node:test";
import { getLiveActivityStatus } from "../src/live-telemetry.js";

const SHA = "a".repeat(40);
const NOW = 1_800_000_000_000;

test("without authenticated observations activity is unknown, never healthy", () => {
  const result = getLiveActivityStatus({ now: NOW });
  assert.equal(result.gitBranch, null);
  assert.equal(result.uncommittedChanges, null);
  assert.equal(result.activeTaskCount, null);
  assert.equal(result.ciHealth, "UNKNOWN");
  assert.equal(result.ciHeadSha, null);
  assert.equal(result.runningTasks, null);
  assert.equal(result.statusReport, "NO_VERIFIED_ACTIVITY_OBSERVATIONS");
});

test("bounded trusted snapshots expose counts without private task details", () => {
  const result = getLiveActivityStatus({
    now: NOW,
    git: { branch: "fix/my-branch", uncommittedChanges: 4 },
    autopilot: {
      counts: { running: 2, queued: 3 },
      tasks: [{ description: "SECRET_CODE", leaseToken: "SECRET_TOKEN" }],
    },
    ci: { source: "verified_ci_result", state: "PASS", headSha: SHA },
  });
  assert.equal(result.gitBranch, "fix/my-branch");
  assert.equal(result.uncommittedChanges, 4);
  assert.equal(result.activeTaskCount, 2);
  assert.equal(result.ciHealth, "PASS");
  assert.equal(result.ciHeadSha, SHA);
  assert.equal(result.runningTasks, null);
  assert.ok(!JSON.stringify(result).includes("SECRET_"));
});

test("client-supplied CI status cannot fabricate success or leak unsafe branches", () => {
  const result = getLiveActivityStatus({
    now: NOW,
    git: { branch: "../secrets", uncommittedChanges: -1 },
    autopilot: { counts: { running: "5" } },
    ci: { source: "client_status", state: "PASS", headSha: SHA },
  });
  assert.equal(result.gitBranch, null);
  assert.equal(result.uncommittedChanges, null);
  assert.equal(result.activeTaskCount, null);
  assert.equal(result.ciHealth, "UNKNOWN");
  assert.equal(result.ciHeadSha, null);
});

test("bounded numeric inputs and CI evidence formats reject malformed values", () => {
  const result = getLiveActivityStatus({
    now: NOW,
    git: { branch: "main", uncommittedChanges: 10_000_000 },
    autopilot: { counts: { running: Number.POSITIVE_INFINITY } },
    ci: { source: "verified_ci_result", state: "PASS", headSha: "wrong-sha" },
  });
  assert.equal(result.uncommittedChanges, null);
  assert.equal(result.activeTaskCount, null);
  assert.equal(result.ciHealth, "UNKNOWN");
  assert.throws(
    () => getLiveActivityStatus({ now: Number.NaN }),
    /LIVE_ACTIVITY_INVALID_TIME/,
  );
});
