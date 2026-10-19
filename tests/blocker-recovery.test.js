import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobRunner } from "../src/jobs.js";
import { AutopilotJournal } from "../src/autopilot.js";
import { definitions, createDispatcher } from "../src/tools.js";
import { observeSupervisorSocket } from "../src/supervisor-socket-observation.js";
import {
  inspectBlockers,
  isTrustedWindowsSupervisorStatus,
  remediationTaskForBlocker,
} from "../src/blocker-recovery.js";

function fixture(
  t,
  runtimeSource = null,
  projectOptions = {},
  supervisorSocket = null,
  nativeSupervisor = null,
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
      ...(nativeSupervisor
        ? {
            supervisorPipe: "\\\\.\\pipe\\kmj-codebridge-supervisor-p720",
            supervisorTokenFile: path.join(base, "supervisor.token"),
          }
        : {}),
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
    nativeSupervisor,
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
  const expectedCode =
    process.platform === "win32"
      ? "WINDOWS_SUPERVISOR_NOT_CONFIGURED"
      : process.platform === "linux"
        ? "SUPERVISOR_NOT_CONFIGURED"
        : "SUPERVISOR_UNSUPPORTED_PLATFORM";
  const expectedStatus =
    process.platform === "win32"
      ? "WINDOWS_PIPE_NOT_CONFIGURED"
      : process.platform === "linux"
        ? "NOT_CONFIGURED"
        : "UNSUPPORTED_OS";
  assert.equal(report.blockerRecovery.supervisor.status, expectedStatus);
  const issue = report.blockerRecovery.blockers.find(
    (entry) => entry.code === expectedCode,
  );
  assert.ok(issue, "platform-specific operator guidance must exist");
  assert.equal(report.blockerRecovery.supervisor.connectionVerified, false);
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
  assert.equal(report.blockerRecovery.supervisor.connectionVerified, false);
  const os = report.blockerRecovery.supervisor.status;
  if (process.platform === "linux") {
    assert.ok(
      [
        "SOCKET_MISSING",
        "SOCKET_PRESENT_UNVERIFIED",
        "SOCKET_PROBE_UNAVAILABLE",
        "UNSAFE_SYMLINK",
        "INVALID_SOCKET_TYPE",
      ].includes(os),
      "Linux filesystem probe must distinguish actual socket state",
    );
  } else {
    assert.equal(
      os,
      process.platform === "win32"
        ? "WINDOWS_PIPE_NOT_CONFIGURED"
        : "UNSUPPORTED_OS",
    );
  }
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

test("doctor requires a trusted live RPC, not a socket file alone", () => {
  const observation = {
    state: "SOCKET_PRESENT_UNVERIFIED",
    observedPlatform: "linux",
    socketExists: true,
    authenticated: false,
    noServiceMutation: true,
  };
  const unverified = inspectBlockers({
    supervisorConfigured: true,
    supervisorObservation: observation,
  });
  assert.equal(unverified.supervisor.connectionVerified, false);
  assert.equal(unverified.supervisor.status, "SOCKET_PRESENT_UNVERIFIED");
  assert.ok(
    unverified.blockers.some(
      (item) => item.code === "SUPERVISOR_HEALTH_NOT_VERIFIED",
    ),
  );

  const verified = inspectBlockers({
    supervisorConfigured: true,
    supervisorObservation: observation,
    supervisorHealthVerified: true,
  });
  assert.equal(verified.supervisor.connectionVerified, true);
  assert.equal(verified.supervisor.status, "LIVE_STATUS_VERIFIED");
  assert.equal(verified.supervisor.filesystemObservation, observation.state);
  assert.ok(
    !verified.blockers.some(
      (item) => item.code === "SUPERVISOR_HEALTH_NOT_VERIFIED",
    ),
  );
  // A verified socket does not imply AI coding, free billing or lease work.
  assert.equal(verified.autonomousCodingProven, false);
  assert.equal(verified.productionOrBillingModified, false);
  assert.equal(verified.taskActuallyClaimed, false);
});

test("doctor rejects invalid or forged live Supervisor health evidence", () => {
  const validSocket = {
    state: "SOCKET_PRESENT_UNVERIFIED",
    authenticated: false,
    noServiceMutation: true,
  };
  for (const invalid of [
    { supervisorConfigured: true, supervisorHealthVerified: "yes" },
    { supervisorConfigured: true, supervisorHealthVerified: true },
    {
      supervisorConfigured: false,
      supervisorHealthVerified: true,
      supervisorObservation: validSocket,
    },
    {
      supervisorConfigured: true,
      supervisorHealthVerified: true,
      supervisorObservation: {
        ...validSocket,
        state: "UNSAFE_SYMLINK",
      },
    },
  ])
    assert.throws(
      () => inspectBlockers(invalid),
      /INVALID_SUPERVISOR_LIVE_EVIDENCE/,
    );
});

test("Windows native Supervisor status needs trusted authenticated shape", () => {
  const ready = {
    service: "agent",
    platform: "win32",
    supervisor: "windows-native",
    installed: true,
    state: "unknown",
    runtime: { commit: "a".repeat(40), source: "git-detached" },
    restart: { supported: false },
    update: { supported: false },
  };
  assert.equal(isTrustedWindowsSupervisorStatus(ready), true);
  for (const forged of [
    null,
    { ...ready, supervisor: "linux" },
    { ...ready, platform: "linux" },
    { ...ready, service: "gateway" },
    { ...ready, installed: false },
    { ...ready, restart: { supported: "true" } },
    { ...ready, update: { supported: true } },
  ])
    assert.equal(isTrustedWindowsSupervisorStatus(forged), false);
});

test("Windows native pipe is not conflated with unsupported Linux socket", () => {
  const observation = {
    state: "WINDOWS_PIPE_CONFIGURED_UNVERIFIED",
    observedPlatform: "win32",
    socketExists: null,
    authenticated: false,
    noServiceMutation: true,
  };
  const unseen = inspectBlockers({
    supervisorConfigured: true,
    supervisorObservation: observation,
  });
  assert.equal(unseen.supervisor.connectionVerified, false);
  assert.ok(
    unseen.blockers.some(
      (entry) => entry.code === "WINDOWS_SUPERVISOR_HEALTH_NOT_VERIFIED",
    ),
  );
  const verified = inspectBlockers({
    supervisorConfigured: true,
    supervisorObservation: observation,
    supervisorHealthVerified: true,
  });
  assert.equal(verified.supervisor.status, "LIVE_STATUS_VERIFIED");
  assert.equal(verified.supervisor.connectionVerified, true);
  assert.ok(
    !verified.blockers.some(
      (entry) => entry.code.startsWith("WINDOWS_SUPERVISOR_"),
    ),
  );
  assert.equal(verified.autonomousCodingProven, false);
  assert.match(verified.supervisor.note, /does not prove/);
});

test("Windows connection doctor validates native pipe response without starting tasks", async (t) => {
  if (process.platform !== "win32") return;
  let calls = 0;
  const supervisor = {
    request: async ({ op, service }) => {
      calls += 1;
      assert.deepEqual({ op, service }, { op: "status", service: "agent" });
      return {
        service: "agent",
        platform: "win32",
        supervisor: "windows-native",
        installed: true,
        state: "unknown",
        restart: { supported: false },
        update: { supported: false },
      };
    },
  };
  const { dispatch, scope } = fixture(t, null, {}, null, supervisor);
  const report = await dispatch("connection_doctor", scope, ["read"]);
  assert.equal(calls, 1);
  assert.equal(report.blockerRecovery.supervisor.connectionVerified, true);
  assert.equal(report.blockerRecovery.supervisor.status, "LIVE_STATUS_VERIFIED");
  assert.equal(report.blockerRecovery.autonomousCodingProven, false);
  assert.equal(report.blockerRecovery.productionOrBillingModified, false);
  supervisor.request = async () => ({ service: "agent", platform: "linux" });
  const refused = await dispatch("connection_doctor", scope, ["read"]);
  assert.equal(refused.blockerRecovery.supervisor.connectionVerified, false);
  assert.ok(
    refused.blockerRecovery.blockers.some(
      (entry) => entry.code === "WINDOWS_SUPERVISOR_HEALTH_NOT_VERIFIED",
    ),
  );
});

test("Linux socket preflight never connects, deletes files or mutates state", () => {
  const paths = [];
  const first = observeSupervisorSocket({
    platform: "linux",
    configured: true,
    lstat: (path) => {
      paths.push(path);
      return { isSocket: () => true, isSymbolicLink: () => false };
    },
  });
  assert.deepEqual(paths, ["/run/kmj-codebridge/supervisor.sock"]);
  assert.equal(first.state, "SOCKET_PRESENT_UNVERIFIED");
  assert.equal(first.authenticated, false);
  assert.equal(first.noServiceMutation, true);
  const unsafe = observeSupervisorSocket({
    platform: "linux",
    configured: true,
    lstat: () => ({ isSocket: () => true, isSymbolicLink: () => true }),
  });
  assert.equal(unsafe.state, "UNSAFE_SYMLINK");
});

test("Linux missing socket and access error are differentiated", () => {
  const absent = observeSupervisorSocket({
    platform: "linux",
    configured: true,
    lstat: () => {
      const e = new Error("not found");
      e.code = "ENOENT";
      throw e;
    },
  });
  const denied = observeSupervisorSocket({
    platform: "linux",
    configured: true,
    lstat: () => {
      const e = new Error("permission denied");
      e.code = "EACCES";
      throw e;
    },
  });
  assert.equal(absent.state, "SOCKET_MISSING");
  assert.equal(absent.socketExists, false);
  assert.equal(denied.state, "SOCKET_PROBE_UNAVAILABLE");
  assert.equal(denied.socketExists, null);
});

test("Windows agent never probes the Linux supervisor socket", () => {
  let called = false;
  const win = observeSupervisorSocket({
    platform: "win32",
    configured: false,
    lstat: () => {
      called = true;
      throw new Error("should not run");
    },
  });
  assert.equal(win.state, "UNSUPPORTED_OS");
  assert.equal(called, false);
  const report = inspectBlockers({
    supervisorConfigured: false,
    supervisorObservation: win,
  });
  assert.equal(report.supervisor.status, "UNSUPPORTED_OS");
  assert.equal(
    report.blockers.some((entry) => entry.code === "SUPERVISOR_NOT_CONFIGURED"),
    false,
  );
  assert.equal(
    report.blockers.some(
      (entry) => entry.code === "SUPERVISOR_UNSUPPORTED_PLATFORM",
    ),
    true,
  );
});

test("untrusted caller cannot forge a connected root supervisor", () => {
  assert.throws(
    () =>
      inspectBlockers({
        supervisorObservation: {
          state: "SOCKET_PRESENT_UNVERIFIED",
          authenticated: true,
          noServiceMutation: true,
        },
      }),
    /INVALID_SUPERVISOR_SOCKET_OBSERVATION/,
  );
  assert.throws(
    () =>
      inspectBlockers({
        supervisorObservation: {
          state: "CONNECTED",
          authenticated: false,
          noServiceMutation: true,
        },
      }),
    /INVALID_SUPERVISOR_SOCKET_OBSERVATION/,
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
