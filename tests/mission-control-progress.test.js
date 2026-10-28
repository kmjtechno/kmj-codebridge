import test from "node:test";
import assert from "node:assert/strict";
import { verifiedDevelopmentProgress } from "../src/mission-control-progress.js";
const now = 1793175000000;
const args = { device: "kmj-elite-main-platform", project: "kmj-main-platform", now };
const report = {
  source: "authenticated_agent_reports",
  deviceId: args.device,
  projectId: args.project,
  observedAtEpochMs: now - 1000,
  queue: { running: 2, queued: 5, waiting: 1, succeeded: 4, failed: 0, cancelled: 0 },
};
test("fresh scoped real agent data reports running and queued without false completion", () => {
  const v = verifiedDevelopmentProgress({ ...args, agentReport: report });
  assert.equal(v.source, "FRESH_AUTHORIZED_AGENT");
  assert.equal(v.counts.running, 2);
  assert.equal(v.counts.queued, 5);
  assert.equal(v.runningConfirmed, true);
  assert.equal(v.wholeProjectCompletionPercent, null);
  assert.equal(v.productionDeployment, "NOT_VERIFIED");
  assert.equal(v.modelExecuting, "NOT_VERIFIED");
  assert.equal(v.backgroundWorker24x7, "NOT_VERIFIED");
});
test("no authenticated report, wrong scope or stale evidence is unknown, not zero", () => {
  for (const candidate of [
    null, { ...report, source: "client_label_online" },
    { ...report, projectId: "other" },
    { ...report, deviceId: "other" },
    { ...report, observedAtEpochMs: now - 90001 },
    { ...report, observedAtEpochMs: now + 5001 },
  ]) {
    const v = verifiedDevelopmentProgress({ ...args, agentReport: candidate });
    assert.equal(v.source, "NOT_VERIFIED");
    assert.equal(v.counts.running, null);
    assert.equal(v.runningConfirmed, false);
  }
});
test("partial task counters are unknown rather than invented zero", () => {
  const v = verifiedDevelopmentProgress({ ...args, agentReport: { ...report, queue: { running: -1, succeeded: 3 } } });
  assert.equal(v.counts.running, null);
  assert.equal(v.counts.queued, null);
  assert.equal(v.counts.succeeded, 3);
});
test("receipts are strictly scope, source, state and recency filtered", () => {
  const receipt = {source: "AUTHORIZED_PROJECT_JOB_RECEIPTS", deviceId: args.device, projectId: args.project,
    state: "succeeded", id: "job-safe", observedAtEpochMs: now - 500};
  const v = verifiedDevelopmentProgress({ ...args, jobReceipts: [
    receipt, { ...receipt, source: "UNTRUSTED" }, { ...receipt, deviceId: "foreign" },
    { ...receipt, projectId: "other" }, { ...receipt, observedAtEpochMs: now - 90001 },
    { ...receipt, state: "production_live" }, { ...receipt, id: "../../../secret" },
  ]});
  assert.equal(v.recent.length, 1);
  assert.equal(v.recent[0].id, "job-safe");
  assert.equal(v.source, "NOT_VERIFIED");
});
test("reject invalid scope and huge receipts", () => {
  assert.throws(() => verifiedDevelopmentProgress({ ...args, device: "../root" }), /INVALID_PROGRESS/);
  assert.throws(() => verifiedDevelopmentProgress({ ...args, jobReceipts: Array(101).fill(null) }), /INVALID_PROGRESS/);
  assert.throws(() => verifiedDevelopmentProgress({ ...args, now: -1 }), /INVALID_PROGRESS/);
});
