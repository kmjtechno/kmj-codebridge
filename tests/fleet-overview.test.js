import test from "node:test";
import assert from "node:assert/strict";
import { fleetLane, fleetSummary } from "../src/fleet-overview.js";
import { definitions } from "../src/tools.js";

const ap = {
  ok: true,
  value: {
    counts: { queued: 3, waiting: 1, succeeded: 2 },
    next: { id: "approved-task", objective: "token=never-display" },
  },
};
const capacity = {
  ok: true,
  value: {
    blocked: false,
    effectiveMaxConcurrent: 1,
    activeJobs: 0,
  },
};

test("fleet tool is bounded and read-only", () => {
  assert.equal(definitions.fleet_overview.access, "read");
  assert.equal(
    definitions.fleet_overview.input.maxProjects.safeParse(13).success,
    false,
  );
  assert.equal(
    definitions.fleet_overview.input.maxProjects.safeParse(12).success,
    true,
  );
});

test("authorized connected lane only reports real slots and scoped task IDs", () => {
  const lane = fleetLane("d1", "p1", "READY", ap, capacity);
  assert.equal(lane.availableSlots, 1);
  assert.equal(lane.nextAction, "CLAIM_APPROVED_READY_TASK");
  assert.equal(lane.wholeProjectCompletionPercent, null);
  assert.equal(lane.productionReleaseReadiness, "NOT_EVALUATED");
  assert.ok(!JSON.stringify(lane).includes("never-display"));
});

test("unregistered and offline devices never receive tasks, slots, or private metadata", () => {
  for (const state of ["GATEWAY_REGISTRATION_MISSING", "AGENT_OFFLINE"]) {
    const lane = fleetLane("d2", "p2", state, ap, capacity);
    assert.equal(lane.nextAction, "RESTORE_AGENT");
    assert.equal(lane.availableSlots, null);
    assert.equal(lane.taskCounts, null);
  }
});

test("resource blocks and existing waiting dependencies are not bypassed", () => {
  const waiting = fleetLane(
    "d",
    "p",
    "READY",
    { ok: true, value: { counts: { queued: 2, waiting: 1 }, next: null } },
    capacity,
  );
  assert.equal(waiting.nextAction, "UNBLOCK_WAITING_TASKS");
  const blocked = fleetLane("d", "p", "READY", ap, {
    ok: true,
    value: { blocked: true, effectiveMaxConcurrent: 8, activeJobs: 0 },
  });
  assert.equal(blocked.availableSlots, 0);
  assert.equal(blocked.nextAction, "RESOLVE_LICENSE_OR_RESOURCE_BLOCK");
});

test("stale agent capability data fails closed", () => {
  const lane = fleetLane("d", "p", "READY", { ok: false }, capacity);
  assert.equal(lane.operational, false);
  assert.equal(lane.taskCounts, null);
  assert.equal(lane.nextAction, "DIAGNOSE_AGENT_CAPABILITIES");
});

test("bounded fleet summary distinguishes project grants from actual capacity", () => {
  const lanes = [
    fleetLane("d1", "p1", "READY", ap, capacity),
    fleetLane("d2", "p2", "AGENT_OFFLINE"),
  ];
  const summary = fleetSummary(lanes, 4);
  assert.equal(summary.totalAuthorizedProjects, 4);
  assert.equal(summary.truncated, true);
  assert.equal(summary.ready, 1);
  assert.equal(summary.actionable, 1);
  assert.equal(summary.actualAvailableJobSlots, 1);
  assert.equal(summary.noJobsStarted, true);
  assert.equal(summary.wholeProjectCompletionPercent, null);
});

test("two granted projects on one device cannot double-count one signed slot", () => {
  const lanes = [
    fleetLane("same-device", "project-a", "READY", ap, capacity),
    fleetLane("same-device", "project-b", "READY", ap, capacity),
  ];
  const summary = fleetSummary(lanes, 2);
  assert.equal(summary.ready, 2);
  assert.equal(summary.actualAvailableJobSlots, 1);
});

test("read-only cross-repo handoff returns only safe scoped IDs", () => {
  const lanes = [
    fleetLane("elite", "main-platform", "READY", ap, capacity),
    fleetLane(
      "p520",
      "omnidesk",
      "READY",
      {
        ok: true,
        value: {
          counts: { queued: 2 },
          next: { id: "task-2", objective: "secret=must-not-appear" },
        },
      },
      capacity,
    ),
  ];
  const summary = fleetSummary(lanes, 2);
  assert.deepEqual(
    summary.nextWork.candidates.map(({ device, project, taskId }) => ({
      device,
      project,
      taskId,
    })),
    [
      { device: "elite", project: "main-platform", taskId: "approved-task" },
      { device: "p520", project: "omnidesk", taskId: "task-2" },
    ],
  );
  assert.equal(summary.nextWork.crossProjectPriorityVerified, false);
  assert.equal(summary.nextWork.workExecutionStarted, false);
  assert.equal(summary.nextWork.ownerApprovalGranted, false);
  assert.ok(!JSON.stringify(summary.nextWork).includes("must-not-appear"));
  assert.ok(!JSON.stringify(summary.nextWork).includes("never-display"));
});

test("fleet suggestions never exceed shared device slots or include unavailable work", () => {
  const lanes = [
    fleetLane("shared", "p1", "READY", ap, capacity),
    fleetLane("shared", "p2", "READY", ap, capacity),
    fleetLane("offline", "p3", "AGENT_OFFLINE", ap, capacity),
    fleetLane("blocked", "p4", "READY", ap, {
      ok: true,
      value: { blocked: true, effectiveMaxConcurrent: 2, activeJobs: 0 },
    }),
  ];
  const summary = fleetSummary(lanes, 6);
  assert.equal(summary.nextWork.partialFleet, true);
  assert.equal(summary.nextWork.candidates.length, 1);
  assert.equal(summary.nextWork.candidates[0].project, "p1");
  assert.equal(summary.nextWork.candidates[0].alreadyClaimed, false);
  assert.equal(summary.actualAvailableJobSlots, 1);
});

test("invalid ready IDs and no active slots fail closed without false work claims", () => {
  const unsafe = fleetLane(
    "d",
    "p",
    "READY",
    { ok: true, value: { counts: { queued: 1 }, next: { id: "token=oops" } } },
    capacity,
  );
  const busy = fleetLane("d2", "p2", "READY", ap, {
    ok: true,
    value: { blocked: false, effectiveMaxConcurrent: 1, activeJobs: 1 },
  });
  const next = fleetSummary([unsafe, busy], 2).nextWork;
  assert.equal(next.status, "NO_READY_CANDIDATES");
  assert.deepEqual(next.candidates, []);
  assert.equal(next.workExecutionStarted, false);
});
