import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutopilotJournal } from "../src/autopilot.js";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-autopilot-dispatch-"));
  const root = path.join(base, "project");
  const state = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  const runner = new JobRunner(path.join(state, "jobs"));
  const autopilot = new AutopilotJournal(path.join(state, "autopilot"));
  const config = {
    id: "d1",
    stateDir: state,
    projects: [{ id: "p1", root, writable: true, gates: {}, commands: {} }],
  };
  const licenseProvider = () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  });
  const dispatch = createDispatcher(config, runner, licenseProvider, autopilot);
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return dispatch;
}

const scope = { device: "d1", project: "p1" };
const permissions = ["read", "write", "execute"];

test("autopilot tools persist, claim, checkpoint and continue independent work", async (t) => {
  const dispatch = setup(t);
  const blocked = await dispatch(
    "autopilot_enqueue",
    {
      ...scope,
      key: "blocked",
      objective: "needs an external approval",
      priority: 20,
      dependsOn: [],
    },
    permissions,
  );
  await dispatch(
    "autopilot_enqueue",
    {
      ...scope,
      key: "independent",
      objective: "safe independent work",
      priority: 10,
      dependsOn: [],
    },
    permissions,
  );

  const claimed = await dispatch("autopilot_claim", scope, permissions);
  assert.equal(claimed.id, blocked.id);
  assert.ok(claimed.leaseToken, "a claim carries its lease token");
  await dispatch(
    "autopilot_checkpoint",
    {
      ...scope,
      task: blocked.id,
      summary: "all safe local work complete",
      next: "resume after approval",
      leaseToken: claimed.leaseToken,
    },
    permissions,
  );
  await dispatch(
    "autopilot_wait",
    {
      ...scope,
      task: blocked.id,
      reason: "owner approval required",
      leaseToken: claimed.leaseToken,
    },
    permissions,
  );

  const next = await dispatch("autopilot_claim", scope, permissions);
  assert.equal(next.key, "independent");
});

// Cross-chat ownership regression: once a task is claimed under
// lease-aware code, every running-state operation must carry a matching
// leaseToken. A second chat/session sharing the same device and project
// scope must not be able to checkpoint or complete another chat's claimed
// work, whether by omitting the token or guessing one.
test("a second chat cannot checkpoint, pause or complete another chat's claimed task", async (t) => {
  const dispatch = setup(t);
  const task = await dispatch(
    "autopilot_enqueue",
    { ...scope, key: "cross-chat", objective: "owned by chat A" },
    permissions,
  );
  const chatA = await dispatch("autopilot_claim", scope, permissions);
  assert.equal(chatA.id, task.id);

  const asChatB = (extra) => ({ ...scope, task: task.id, ...extra });

  await assert.rejects(
    dispatch(
      "autopilot_checkpoint",
      asChatB({ summary: "hijacked", next: "n" }),
      permissions,
    ),
    /AUTOPILOT_LEASE_LOST/,
    "no token at all is rejected",
  );
  await assert.rejects(
    dispatch(
      "autopilot_checkpoint",
      asChatB({
        summary: "hijacked",
        next: "n",
        leaseToken: "00000000-0000-0000-0000-000000000000",
      }),
      permissions,
    ),
    /AUTOPILOT_LEASE_LOST/,
    "a guessed token is rejected",
  );
  await assert.rejects(
    dispatch(
      "autopilot_wait",
      asChatB({ reason: "chat B trying to pause chat A's task" }),
      permissions,
    ),
    /AUTOPILOT_LEASE_LOST/,
  );
  await assert.rejects(
    dispatch(
      "autopilot_complete",
      asChatB({ state: "succeeded", result: "hijacked" }),
      permissions,
    ),
    /AUTOPILOT_LEASE_LOST/,
  );

  // Chat A, the real holder, still works.
  const checkpointed = await dispatch(
    "autopilot_checkpoint",
    {
      ...scope,
      task: task.id,
      summary: "legitimate progress",
      next: "continue",
      leaseToken: chatA.leaseToken,
    },
    permissions,
  );
  assert.equal(checkpointed.checkpoint.summary, "legitimate progress");
  const completed = await dispatch(
    "autopilot_complete",
    {
      ...scope,
      task: task.id,
      state: "succeeded",
      result: "done by chat A",
      leaseToken: chatA.leaseToken,
    },
    permissions,
  );
  assert.equal(completed.state, "succeeded");
});

// Cross-chat ownership after expiry: chat B may legitimately take over once
// chat A's lease has expired, but chat A's now-stale token must stop
// working the instant chat B reclaims the task.
test("after lease expiry, the new holder's claim invalidates the old holder's token", async (t) => {
  // A fresh dispatcher with a short, controllable-clock lease so expiry can
  // be driven deterministically, independent of the shared setup()'s dispatch.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-autopilot-expiry-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  // AutopilotJournal clamps leaseMs to a 60 s minimum, so the clock must
  // advance past that floor (not the raw value passed in) for expiry.
  const leaseMs = 60 * 1000;
  const journal = new AutopilotJournal(path.join(base, "autopilot"), {
    leaseMs,
    now: () => 1_000_000,
  });
  const runner = new JobRunner(path.join(base, "jobs"));
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const expiryDispatch = createDispatcher(
    {
      id: "d1",
      stateDir: base,
      projects: [{ id: "p1", root, writable: true, gates: {}, commands: {} }],
    },
    runner,
    () => ({ features: permissions, limits: { concurrent_jobs: 1 } }),
    journal,
  );

  const task = await expiryDispatch(
    "autopilot_enqueue",
    { ...scope, key: "expiry", objective: "time-bounded work" },
    permissions,
  );
  const chatA = await expiryDispatch("autopilot_claim", scope, permissions);
  assert.equal(chatA.id, task.id);

  journal.now = () => 1_000_000 + leaseMs + 1000; // past the clamped lease
  const chatB = await expiryDispatch("autopilot_claim", scope, permissions);
  assert.equal(chatB.id, task.id, "the expired task is reclaimable");
  assert.notEqual(chatB.leaseToken, chatA.leaseToken);

  await assert.rejects(
    expiryDispatch(
      "autopilot_checkpoint",
      {
        ...scope,
        task: task.id,
        summary: "chat A still thinks it owns this",
        next: "n",
        leaseToken: chatA.leaseToken,
      },
      permissions,
    ),
    /AUTOPILOT_LEASE_LOST/,
  );
  const ok = await expiryDispatch(
    "autopilot_complete",
    {
      ...scope,
      task: task.id,
      state: "succeeded",
      result: "done by chat B",
      leaseToken: chatB.leaseToken,
    },
    permissions,
  );
  assert.equal(ok.state, "succeeded");
});

test("autopilot status is read-only and bounded", async (t) => {
  const dispatch = setup(t);
  await dispatch(
    "autopilot_enqueue",
    {
      ...scope,
      key: "status",
      objective: "status task",
      priority: 0,
      dependsOn: [],
    },
    permissions,
  );
  const status = await dispatch("autopilot_status", { ...scope, limit: 10 }, [
    "read",
  ]);
  assert.equal(status.counts.queued, 1);
  assert.equal(status.tasks.length, 1);
  assert.equal(status.next.key, "status");
});

test("mission tools compile persisted DAG and map evidence", async (t) => {
  const dispatch = setup(t);
  const mission = await dispatch(
    "mission_compile",
    {
      ...scope,
      key: "mission",
      objective: "Ship a verified change.",
      acceptanceCriteria: ["Verification passes."],
      requirements: {
        security: [],
        reliability: ["Resume after restart."],
        performance: [],
        documentation: [],
      },
      tasks: [
        {
          key: "verify",
          objective: "Run verification.",
          priority: 5,
          dependsOn: [],
        },
      ],
      ownerGates: ["Production deploy requires approval."],
      definitionOfDone: "Verification evidence recorded.",
      aiBudget: "balanced",
    },
    permissions,
  );
  assert.equal(mission.state, "active");
  assert.equal(mission.tasks[0].key, "verify");

  const claimed = await dispatch("autopilot_claim", scope, permissions);
  await dispatch(
    "autopilot_complete",
    {
      ...scope,
      task: claimed.id,
      state: "succeeded",
      result: "verification green",
      leaseToken: claimed.leaseToken,
    },
    permissions,
  );
  const pending = await dispatch(
    "mission_status",
    { ...scope, mission: mission.id },
    ["read"],
  );
  assert.equal(pending.state, "evidence_pending");

  const complete = await dispatch(
    "mission_evidence",
    {
      ...scope,
      mission: mission.id,
      criterionIndex: 0,
      evidence: "Exact-head CI passed.",
    },
    permissions,
  );
  assert.equal(complete.state, "succeeded");
});
