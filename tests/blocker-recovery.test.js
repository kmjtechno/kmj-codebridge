import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobRunner } from "../src/jobs.js";
import { AutopilotJournal } from "../src/autopilot.js";
import { definitions, createDispatcher } from "../src/tools.js";
import {
  inspectBlockers,
  remediationTaskForBlocker,
} from "../src/blocker-recovery.js";

function fixture(
  t,
  runtimeSource = null,
  projectOptions = {},
  supervisorSocket = null,
) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-blocker-recovery-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "unchanged.txt"), "other agent work\n");
  const runner = new JobRunner(path.join(base, "jobs"));
  t.after(async () => runner.close());
  const autopilot = new AutopilotJournal(path.join(base, "autopilot"));
  const license = () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  });
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir: path.join(base, "state"),
      ...(supervisorSocket ? { supervisorSocket } : {}),
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
    autopilot,
    null,
    null,
    undefined,
    runtimeSource,
  );
  return {
    dispatch,
    autopilot,
    scope: { device: "device1", project: "project1" },
    root,
  };
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

test("supervisor absent is diagnosed from runtime config without privilege escalation", async (t) => {
  const { dispatch, scope } = fixture(t);
  const report = await dispatch("connection_doctor", scope, ["read"]);
  assert.equal(report.blockerRecovery.supervisor.configured, false);
  assert.equal(report.blockerRecovery.supervisor.connectionVerified, false);
  assert.equal(report.blockerRecovery.supervisor.status, "NOT_CONFIGURED");
  const issue = report.blockerRecovery.blockers.find(
    (entry) => entry.code === "SUPERVISOR_NOT_CONFIGURED",
  );
  assert.equal(
    issue.requiredCodeBridgeFeature,
    "SAFE_SUPERVISOR_BOOTSTRAP_AND_AGENT_BINDING",
  );
  assert.match(issue.nextAction, /existing credentials/);
  assert.equal(report.blockerRecovery.productionOrBillingModified, false);
});

test("configured supervisor does not imply a live privileged socket", async (t) => {
  const { dispatch, scope } = fixture(
    t,
    null,
    {},
    "/run/kmj-codebridge/supervisor.sock",
  );
  const report = await dispatch("connection_doctor", scope, ["read"]);
  assert.equal(report.blockerRecovery.supervisor.configured, true);
  assert.equal(report.blockerRecovery.supervisor.connectionVerified, false);
  assert.equal(report.blockerRecovery.supervisor.status, "NOT_PROBED");
  assert.ok(
    report.blockerRecovery.blockers.some(
      (entry) => entry.code === "SUPERVISOR_HEALTH_NOT_VERIFIED",
    ),
  );
  assert.equal(report.blockerRecovery.taskActuallyClaimed, false);
});

test("strict supervisor observation cannot invent verified health", () => {
  assert.throws(
    () => inspectBlockers({ supervisorConfigured: "yes" }),
    /INVALID_SUPERVISOR_OBSERVATION/,
  );
  const r = inspectBlockers({ supervisorConfigured: null });
  assert.equal(r.supervisor.status, "UNKNOWN");
  assert.equal(
    r.blockers.some((item) => item.code === "SUPERVISOR_NOT_CONFIGURED"),
    false,
  );
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
    report.blockers.some(
      (item) => item.code === "WORKER_CONFIGURED_NOT_STARTED",
    ),
    false,
  );
  assert.equal(
    report.blockers.some(
      (item) => item.code === "WORKER_STATUS_NOT_INSTRUMENTED",
    ),
    true,
  );
});

test("dirty project means preserve existing work and continue independently", () => {
  const report = inspectBlockers({ checkoutState: "dirty" });
  assert.equal(report.safeIndependentWorkCanContinue, true);
  assert.equal(
    report.blockers.some((item) => item.code === "CHECKOUT_DIRTY"),
    true,
  );
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
  assert.equal(
    observed.blockerRecovery.workerHealth.localDraft.loopStarted,
    false,
  );
  assert.deepEqual(observed.blockerRecovery.clientModelToolsMissing, [
    "local_model_generate",
    "autopilot_local_draft",
  ]);
  assert.equal(
    observed.blockerRecovery.blockers.some(
      (item) => item.code === "CI_NO_RUNNER_STEPS",
    ),
    true,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "unchanged.txt"), "utf8"),
    "other agent work\n",
  );
  assert.deepEqual(fs.readdirSync(root), ["unchanged.txt"]);
});

test("permission and project boundary remain guarded", async (t) => {
  const { dispatch, scope } = fixture(t);
  await assert.rejects(
    dispatch("connection_doctor", scope, ["write"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("connection_doctor", { ...scope, project: "someone-else" }, [
      "read",
    ]),
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

test("authorized waiting task hands off a bounded recovery feature without executing actions", async (t) => {
  const { dispatch, autopilot, scope, root } = fixture(t);
  const queued = autopilot.enqueue({
    project: "project1",
    key: "task:a",
    objective: "Review failed CI job",
  });
  const claimed = autopilot.claim("project1");
  assert.equal(claimed.id, queued.id);
  const result = await dispatch(
    "autopilot_wait",
    {
      ...scope,
      task: claimed.id,
      reason: "No GitHub Actions runner steps",
      leaseToken: claimed.leaseToken,
      blockerCode: "CI_NO_RUNNER_STEPS",
    },
    ["write"],
  );
  assert.equal(result.state, "waiting");
  assert.equal(result.remediation.queued, true);
  assert.equal(result.remediation.executionStarted, false);
  const recovery = autopilot.get(result.remediation.task, "project1");
  assert.equal(recovery.state, "queued");
  assert.equal(recovery.priority, 90);
  assert.match(
    recovery.objective,
    /FIRST_PARTY_CI_CAPACITY_AND_BOOTSTRAP_DIAGNOSTIC/,
  );
  assert.equal(recovery.dependsOn.length, 0);
  assert.equal(
    fs.readFileSync(path.join(root, "unchanged.txt"), "utf8"),
    "other agent work\n",
  );
});

test("invalid lease cannot queue a recovery task or pause another worker", async (t) => {
  const { dispatch, autopilot, scope } = fixture(t);
  autopilot.enqueue({
    project: "project1",
    key: "task:b",
    objective: "Important work",
  });
  const claimed = autopilot.claim("project1");
  await assert.rejects(
    dispatch(
      "autopilot_wait",
      {
        ...scope,
        task: claimed.id,
        reason: "Blocked",
        leaseToken: "00000000-0000-4000-8000-000000000000",
        blockerCode: "CLIENT_TOOL_NOT_ADVERTISED",
      },
      ["write"],
    ),
    /AUTOPILOT_LEASE_LOST/,
  );
  assert.equal(autopilot.get(claimed.id, "project1").state, "running");
  assert.equal(autopilot.status("project1", 50).counts.queued, 0);
});

test("recovery task IDs are scoped to source task and idempotent", (t) => {
  const { autopilot } = fixture(t);
  const uuid = "3f3f3f3f-1234-4123-8123-aaaa1234abcd";
  const spec = remediationTaskForBlocker("CHECKOUT_DIRTY", uuid);
  assert.match(spec.key, /^blocker:checkout_dirty:/);
  assert.equal(spec.key.includes("-"), false);
  const first = autopilot.enqueue({ project: "project1", ...spec });
  const repeated = autopilot.enqueue({ project: "project1", ...spec });
  assert.equal(repeated.id, first.id);
  assert.equal(spec.dependsOn.length, 0);
  assert.throws(
    () => remediationTaskForBlocker("ROOT_SHELL_OVERRIDE", uuid),
    /UNKNOWN_RECOVERY_CODE/,
  );
});
