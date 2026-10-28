import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildDevelopmentFlow } from "../src/development-flow.js";

const scope = { device: "device1", project: "project1", lane: "codebridge-24x7" };
const checkpoint = {
  exists: true,
  revision: "a".repeat(64),
  objective: "Ship user-approved AI workspace",
  summary: "Source merged but deployment is not verified.",
  blockers: ["Stable signing still requires owner evidence"],
  nextSteps: ["Recheck exact-head CI and approved release gates"],
};

test("one-call roadmap resumes saved objective, next step and blocker without GitHub reread", () => {
  const flow = buildDevelopmentFlow({ ...scope, checkpoint });
  assert.equal(flow.roadmap.status, "CHECKPOINT_SAVED_UNVERIFIED");
  assert.equal(flow.roadmap.revision, checkpoint.revision);
  assert.equal(flow.roadmap.objective, checkpoint.objective);
  assert.deepEqual(flow.roadmap.nextSteps, checkpoint.nextSteps);
  assert.equal(flow.recommendedAction.code, "REVIEW_REPORTED_BLOCKERS");
  assert.equal(flow.resume.tool, "chat_workspace_open");
  assert.equal(flow.resume.lane, scope.lane);
  assert.equal(flow.work.releaseVerified, false);
  assert.equal(flow.safety.noAutomaticProductionCutover, true);
});

test("no saved roadmap remains unknown; never invent readiness or execution", () => {
  const flow = buildDevelopmentFlow({ ...scope });
  assert.equal(flow.roadmap.status, "NO_SAVED_CHECKPOINT");
  assert.equal(flow.roadmap.objective, null);
  assert.equal(flow.work.automatedExecutionVerified, false);
  assert.equal(flow.work.taskJournalAvailable, false);
  assert.equal(flow.recommendedAction.code, "CAPTURE_NEXT_MILESTONE");
});

test("verified-scope ready task is a proposed verification, never auto-execution", () => {
  const flow = buildDevelopmentFlow({
    ...scope,
    checkpoint: { ...checkpoint, blockers: [] },
    progress: { taskTrackingAvailable: true, nextReadyTaskId: "task-17" },
  });
  assert.equal(flow.work.nextReadyTaskId, "task-17");
  assert.deepEqual(flow.recommendedAction, {
    code: "VERIFY_NEXT_READY_TASK",
    source: "AUTHORIZED_PROJECT_TASK_JOURNAL",
    taskId: "task-17",
  });
  assert.equal(flow.work.automatedExecutionVerified, false);
});

test("foreign, corrupt and malformed saved state cannot be surfaced as a roadmap", () => {
  for (const other of [
    { ...checkpoint, project: "another-project" },
    { ...checkpoint, lane: "other-lane" },
    { ...checkpoint, revision: "NOT_A_REVISION" },
    { ...checkpoint, exists: false },
  ]) {
    const flow = buildDevelopmentFlow({ ...scope, checkpoint: other });
    assert.equal(flow.roadmap.status, "NO_SAVED_CHECKPOINT");
    assert.equal(flow.roadmap.summary, null);
    assert.equal(flow.roadmap.nextSteps.length, 0);
  }
  const safe = buildDevelopmentFlow({
    ...scope,
    checkpoint: {
      ...checkpoint,
      blockers: ["valid", "x".repeat(300), "password=supersecret"],
      nextSteps: ["valid task", "bad\ncommand"],
    },
    progress: { taskTrackingAvailable: false, nextReadyTaskId: "task-7" },
  });
  assert.equal(safe.roadmap.blockers.includes("x".repeat(300)), false);
  assert.equal(safe.roadmap.nextSteps.includes("bad\ncommand"), false);
  assert.ok(!JSON.stringify(safe).includes("supersecret"));
  assert.equal(safe.work.nextReadyTaskId, null);
});

test("gateway one-call and ordinary workspace both expose same guarded flow", () => {
  const source = fs.readFileSync(
    new URL("../src/gateway.js", import.meta.url),
    "utf8",
  );
  const widget = fs.readFileSync(
    new URL("../src/chat-workspace-open.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /developmentFlow: buildDevelopmentFlow\(/);
  assert.match(source, /resolveChatWorkspaceCheckpoint\(/);
  assert.match(widget, /developmentFlow: buildDevelopmentFlow\(/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf("  async function getMultiChatSync("),
      source.indexOf("  const fastReadTools =", source.indexOf("  async function getMultiChatSync(")),
    ),
    /run_quality_gate|write_file|spawn\(/,
  );
});
