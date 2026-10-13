import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDispatcher, definitions } from "../src/tools.js";

function fixture(t, workerSource) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-worker-status-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  const config = {
    id: "device1",
    stateDir: base,
    projects: [
      {
        id: "project1",
        root,
        writable: true,
        commands: {},
        gates: {},
        autopilotGateWorker: { enabled: true },
        autopilotRepairWorker: { enabled: true, recipes: {} },
        autopilotCiWatch: { enabled: true },
        autopilotLocalWorker: { enabled: false },
      },
    ],
  };
  const runner = {
    dir: path.join(base, "jobs"),
    maxConcurrent: 1,
  };
  const dispatch = createDispatcher(
    config,
    runner,
    () => ({
      features: ["read"],
      limits: { concurrent_jobs: 1 },
    }),
    null,
    null,
    null,
    undefined,
    workerSource,
  );
  return { dispatch };
}

test("runtime status shows started loops distinctly from configuration", async (t) => {
  const f = fixture(t, () => ({
    gate: ["project1"],
    repair: ["project1"],
    githubCiWatch: [],
    localDraft: [],
    agentRunning: true,
    token: "hidden-token-not-for-output",
  }));
  const r = await f.dispatch(
    "autopilot_worker_runtime_status",
    { device: "device1", project: "project1" },
    ["read"],
  );
  assert.equal(r.evidence, "ACTIVE_AGENT_WORKER_HANDLES");
  assert.equal(r.processAvailable, true);
  assert.deepEqual(r.workers.gate, {
    configured: true,
    loopStarted: true,
  });
  assert.deepEqual(r.workers.githubCiWatch, {
    configured: true,
    loopStarted: false,
  });
  assert.deepEqual(r.workers.localDraft, {
    configured: false,
    loopStarted: false,
  });
  assert.doesNotMatch(JSON.stringify(r), /hidden-token-not-for-output/);
  assert.match(r.note, /not evidence/);
});

test("unconfigured process status never fabricates started workers", async (t) => {
  const f = fixture(t, null);
  const r = await f.dispatch(
    "autopilot_worker_runtime_status",
    { device: "device1", project: "project1" },
    ["read"],
  );
  assert.equal(r.evidence, "NOT_INSTRUMENTED");
  assert.equal(r.processAvailable, false);
  assert.equal(r.workers.repair.loopStarted, null);
  assert.equal(r.workers.repair.configured, true);
});

test("read authorization and device/project isolation are retained", async (t) => {
  const f = fixture(t, () => ({
    gate: [],
    repair: [],
    githubCiWatch: [],
    localDraft: [],
    agentRunning: true,
  }));
  assert.equal(definitions.autopilot_worker_runtime_status.access, "read");
  await assert.rejects(
    f.dispatch(
      "autopilot_worker_runtime_status",
      { device: "device1", project: "project1" },
      ["write"],
    ),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    f.dispatch(
      "autopilot_worker_runtime_status",
      { device: "different", project: "project1" },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    f.dispatch(
      "autopilot_worker_runtime_status",
      { device: "device1", project: "other_project" },
      ["read"],
    ),
    /PROJECT_NOT_FOUND/,
  );
});
