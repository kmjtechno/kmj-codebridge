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
    projects: [{ id: "p1", root, writable: true, gates: {} }],
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

test(
  "autopilot tools persist, claim, checkpoint and continue independent work",
  async (t) => {
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
  await dispatch(
    "autopilot_checkpoint",
    {
      ...scope,
      task: blocked.id,
      summary: "all safe local work complete",
      next: "resume after approval",
    },
    permissions,
  );
  await dispatch(
    "autopilot_wait",
    { ...scope, task: blocked.id, reason: "owner approval required" },
    permissions,
  );

  const next = await dispatch("autopilot_claim", scope, permissions);
    assert.equal(next.key, "independent");
  },
);

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
  const status = await dispatch(
    "autopilot_status",
    { ...scope, limit: 10 },
    ["read"],
  );
  assert.equal(status.counts.queued, 1);
  assert.equal(status.tasks.length, 1);
  assert.equal(status.next.key, "status");
});
