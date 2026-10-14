import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobRunner } from "../src/jobs.js";
import { definitions, createDispatcher } from "../src/tools.js";
import { inspectBlockers } from "../src/blocker-recovery.js";

function fixture(t, runtimeSource = null, projectOptions = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-blocker-recovery-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "unchanged.txt"), "other agent work\n");
  const runner = new JobRunner(path.join(base, "jobs"));
  t.after(async () => runner.close());
  const license = () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  });
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir: path.join(base, "state"),
      projects: [
        {
          id: "project1",
          root,
          writable: true,
          gates: {},
          commands: {},
          ...projectOptions,
        },
      ],
    },
    runner,
    license,
    null,
    null,
    null,
    undefined,
    runtimeSource,
  );
  return { dispatch, scope: { device: "device1", project: "project1" }, root };
}

test("recovery advisor maps absent client tool exposure to a safe native fix without privilege escalation", () => {
  const result = inspectBlockers({
    clientVisibleTools: ["connection_doctor", "autopilot_status"],
  });
  assert.equal(result.mode, "READ_ONLY_ADVICE");
  assert.deepEqual(result.clientModelToolsMissing, [
    "local_model_status",
    "local_model_generate",
    "autopilot_local_draft",
  ]);
  assert.equal(
    result.blockers[0].requiredCodeBridgeFeature,
    "HOSTED_MCP_TOOL_CAPTURE_DIAGNOSTIC",
  );
  assert.equal(result.autonomousCodingProven, false);
  assert.equal(result.taskActuallyClaimed, false);
  assert.equal(result.productionOrBillingModified, false);
});

test("unknown client capture is not reported as missing", () => {
  const result = inspectBlockers();
  assert.equal(result.clientToolSnapshotProvided, false);
  assert.equal(result.clientModelToolsMissing, null);
  assert.equal(
    result.blockers.some((item) => item.code === "CLIENT_TOOL_NOT_ADVERTISED"),
    false,
  );
});

test("failed job bootstrap differs from an actually executed source test", () => {
  const missingRunner = inspectBlockers({ ciObservation: "job-no-steps" });
  const failedTest = inspectBlockers({ ciObservation: "executed-test-fail" });
  assert.equal(
    missingRunner.blockers.find((item) => item.code === "CI_NO_RUNNER_STEPS")
      ?.requiredCodeBridgeFeature,
    "FIRST_PARTY_CI_CAPACITY_AND_BOOTSTRAP_DIAGNOSTIC",
  );
  assert.equal(
    failedTest.blockers.find((item) => item.code === "CI_TEST_FAILURE")
      ?.requiredCodeBridgeFeature,
    "EXACT_HEAD_CI_FAILURE_TRIAGE",
  );
  assert.equal(
    missingRunner.blockers.some((item) => item.code === "CI_TEST_FAILURE"),
    false,
  );
});

test("configured but not started worker never implies a coder", () => {
  const report = inspectBlockers({
    workerConfiguration: { gate: true, localDraft: true },
    workerStarted: { gate: true, localDraft: false },
  });
  assert.equal(report.workerHealth.gate.loopStarted, true);
  assert.equal(report.workerHealth.localDraft.loopStarted, false);
  assert.equal(
    report.blockers.some(
      (item) =>
        item.code === "WORKER_CONFIGURED_NOT_STARTED" &&
        item.evidence.worker === "localDraft",
    ),
    true,
  );
  assert.equal(report.autonomousCodingProven, false);
});

test("unobserved worker cannot be declared stopped", () => {
  const report = inspectBlockers({
    workerConfiguration: { localDraft: true },
  });
  assert.equal(report.workerHealth.localDraft.loopStarted, null);
  assert.equal(
    report.blockers.some((item) => item.code === "WORKER_CONFIGURED_NOT_STARTED"),
    false,
  );
  assert.equal(
    report.blockers.some((item) => item.code === "WORKER_STATUS_NOT_INSTRUMENTED"),
    true,
  );
});

test("dirty project means preserve existing work and continue independently", () => {
  const report = inspectBlockers({ checkoutState: "dirty" });
  assert.equal(report.safeIndependentWorkCanContinue, true);
  assert.equal(report.blockers.some((item) => item.code === "CHECKOUT_DIRTY"), true);
  assert.match(
    report.blockers.find((item) => item.code === "CHECKOUT_DIRTY").nextAction,
    /Preserve all uncommitted changes/,
  );
});

test("recovery doctor is callable from existing MCP client, remains read-only and never alters project files", async (t) => {
  const { dispatch, scope, root } = fixture(
    t,
    () => ({
      agentRunning: true,
      gate: ["project1"],
      repair: [],
      githubCiWatch: [],
      localDraft: [],
    }),
    {
      autopilotGateWorker: { enabled: true, gates: ["fast"] },
      autopilotLocalWorker: { enabled: true },
    },
  );
  assert.equal(definitions.connection_doctor.access, "read");
  const observed = await dispatch(
    "connection_doctor",
    {
      ...scope,
      clientVisibleTools: ["connection_doctor", "local_model_status"],
      ciObservation: "job-no-steps",
      checkoutState: "dirty",
    },
    ["read"],
  );
  assert.equal(observed.connection, "connected");
  assert.equal(observed.blockerRecovery.workerHealth.gate.loopStarted, true);
  assert.equal(observed.blockerRecovery.workerHealth.localDraft.loopStarted, false);
  assert.deepEqual(observed.blockerRecovery.clientModelToolsMissing, [
    "local_model_generate",
    "autopilot_local_draft",
  ]);
  assert.equal(
    observed.blockerRecovery.blockers.some((item) => item.code === "CI_NO_RUNNER_STEPS"),
    true,
  );
  assert.equal(fs.readFileSync(path.join(root, "unchanged.txt"), "utf8"), "other agent work\n");
  assert.deepEqual(fs.readdirSync(root), ["unchanged.txt"]);
});

test("permission and project boundary remain guarded", async (t) => {
  const { dispatch, scope } = fixture(t);
  await assert.rejects(
    dispatch("connection_doctor", scope, ["write"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("connection_doctor", { ...scope, project: "someone-else" }, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
  await assert.rejects(
    dispatch(
      "connection_doctor",
      { ...scope, clientVisibleTools: ["bad tool"] },
      ["read"],
    ),
    /invalid_string|Invalid|ZodError|regex/i,
  );
});

test("falsified input cannot be mistaken for verified executor or billing authorization", () => {
  assert.throws(
    () => inspectBlockers({ clientVisibleTools: ["valid", "invalid token"] }),
    /INVALID_CLIENT_TOOL_OBSERVATION/,
  );
  assert.throws(
    () => inspectBlockers({ ciObservation: "ci-passed-forever" }),
    /INVALID_BLOCKER_OBSERVATION/,
  );
  const r = inspectBlockers({
    clientVisibleTools: [
      "local_model_status",
      "local_model_generate",
      "autopilot_local_draft",
    ],
    ciObservation: "passed",
    checkoutState: "clean",
  });
  assert.deepEqual(r.clientModelToolsMissing, []);
  assert.equal(r.autonomousCodingProven, false);
  assert.equal(r.productionOrBillingModified, false);
});
