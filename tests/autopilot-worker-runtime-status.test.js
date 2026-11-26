import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDispatcher, definitions } from "../src/tools.js";
import { AutopilotJournal } from "../src/autopilot.js";

function fixture(t, workerSource, codingConfigured = false) {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "codebridge-worker-status-"),
  );
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
        ...(codingConfigured
          ? {
              autopilotCodingWorker:
                typeof codingConfigured === "object"
                  ? codingConfigured
                  : {
                      enabled: true,
                      localProcessingApproved: true,
                      model: "qwen3:4b",
                      recipes: {},
                    },
            }
          : {}),
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
    new AutopilotJournal(path.join(base, "autopilot")),
    null,
    null,
    undefined,
    workerSource,
  );
  return { dispatch, config };
}

test("runtime status shows started loops distinctly from configuration", async (t) => {
  const f = fixture(
    t,
    () => ({
      gate: ["project1"],
      repair: ["project1"],
      githubCiWatch: [],
      localDraft: [],
      coding: ["project1"],
      agentRunning: true,
      token: "hidden-token-not-for-output",
    }),
    true,
  );
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
  assert.deepEqual(r.workers.coding, {
    configured: true,
    localProcessingApproved: true,
    loopStarted: true,
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
  assert.equal(r.workers.coding.configured, false);
  assert.equal(r.workers.coding.loopStarted, null);
});

test("read authorization and device/project isolation are retained", async (t) => {
  const f = fixture(t, () => ({
    gate: [],
    repair: [],
    githubCiWatch: [],
    localDraft: [],
    coding: [],
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

test("verified-free-cloud coding reports configured without local model consent", async (t) => {
  const f = fixture(t, () => ({ coding: ["project1"], agentRunning: true }), {
    enabled: true,
    inferenceRoute: "verified-free-cloud-only",
    localProcessingApproved: false,
    cloudProxyApproved: true,
    cloudSourceTransferApproved: true,
    model: "auto:or-free",
    recipes: {},
  });
  const r = await f.dispatch(
    "autopilot_worker_runtime_status",
    { device: "device1", project: "project1" },
    ["read"],
  );
  assert.deepEqual(r.workers.coding, {
    configured: true,
    localProcessingApproved: false,
    loopStarted: true,
  });
});

test("cloud coding missing separate source-transfer consent never reports configured", async (t) => {
  const f = fixture(t, () => ({ coding: [], agentRunning: true }), {
    enabled: true,
    inferenceRoute: "verified-free-cloud-only",
    localProcessingApproved: false,
    cloudProxyApproved: true,
    cloudSourceTransferApproved: false,
    model: "auto:or-free",
    recipes: {},
  });
  const r = await f.dispatch(
    "autopilot_worker_runtime_status",
    { device: "device1", project: "project1" },
    ["read"],
  );
  assert.equal(r.workers.coding.configured, false);
  assert.equal(r.workers.coding.localProcessingApproved, false);
  assert.equal(r.workers.coding.loopStarted, false);
});

test("local-only worker missing local consent cannot report configured", async (t) => {
  const f = fixture(t, null, {
    enabled: true,
    inferenceRoute: "local-only",
    localProcessingApproved: false,
    model: "qwen3:4b",
    recipes: {},
  });
  const r = await f.dispatch(
    "autopilot_worker_runtime_status",
    { device: "device1", project: "project1" },
    ["read"],
  );
  assert.equal(r.workers.coding.configured, false);
});

test("native readiness exposes only bounded project-scoped evidence", async (t) => {
  const config = {
    enabled: true,
    inferenceRoute: "native-verified-free-cloud-only",
    nativeModelFabricApproved: true,
    cloudSourceTransferApproved: true,
    cloudProxyApproved: false,
    localProcessingApproved: false,
    model: "modelfabric-auto",
    nativeTokenEnv: "CODEBRIDGE_KMJ_MODELFABRIC_TOKEN",
  };
  let state = "FREE_ADMISSION_CACHED";
  let probes = 0;
  const f = fixture(
    t,
    () => ({
      coding: ["project1"],
      agentRunning: true,
      nativeCodingReadiness: (project) => {
        assert.equal(project, "project1");
        probes++;
        return state;
      },
    }),
    config,
  );
  const read = () =>
    f.dispatch(
      "autopilot_worker_runtime_status",
      { device: "device1", project: "project1" },
      ["read"],
    );
  const first = await read();
  assert.deepEqual(first.workers.coding.nativeModelFabric, {
    readiness: "FREE_ADMISSION_CACHED",
    evidence: "CACHED_OBSERVATION_ONLY",
    liveInferenceVerified: false,
  });
  state = "private-secret-invalid-state";
  const second = await read();
  assert.equal(
    second.workers.coding.nativeModelFabric.readiness,
    "NOT_INSTRUMENTED",
  );
  assert.doesNotMatch(JSON.stringify(second), /private-secret-invalid-state/);
  assert.equal(probes, 2);
});
