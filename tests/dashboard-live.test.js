import assert from "node:assert/strict";
import { test } from "node:test";
import { getLiveDashboardMetrics } from "../src/dashboard-live.js";

const NOW = 1_800_000_000_000;
const sample = (overrides = {}) => ({
  source: "authenticated_agent_reports",
  deviceId: "device1",
  projectId: "kmj-codebridge",
  observedAtEpochMs: NOW - 1_000,
  queue: { queued: 2, running: 1 },
  ...overrides,
});

const grant = (deviceId, projectId = "kmj-codebridge") => ({
  deviceId,
  projectId,
});

test("no agent evidence never fabricates online devices, queue or AI health", () => {
  const result = getLiveDashboardMetrics({ now: NOW });
  assert.equal(result.activeDevices, null);
  assert.equal(result.offlineDevices, null);
  assert.equal(result.fleetStatus, "UNKNOWN");
  assert.equal(result.aiRoutingEngine.activeMode, null);
  assert.deepEqual(result.projects, []);
  assert.equal(result.partial, true);
});

test("only a fresh authorized report counts and repeated device samples deduplicate", () => {
  const result = getLiveDashboardMetrics({
    now: NOW,
    authorizedDeviceIds: ["device1", "device2", "revoked"],
    authorizedProjectGrants: [grant("device1"), grant("device2")],
    reports: [
      sample({
        queue: { queued: 99, running: 9 },
        observedAtEpochMs: NOW - 10_000,
      }),
      sample(),
      sample({
        deviceId: "device2",
        projectId: "kmj-codebridge",
        queue: { queued: 3, running: 0 },
      }),
      sample({ deviceId: "stranger", queue: { queued: 700, running: 0 } }),
    ],
  });
  assert.equal(result.activeDevices, 2);
  assert.equal(result.authorizedDevices, 3);
  assert.equal(result.notReportingDevices, 1);
  assert.equal(result.offlineDevices, null);
  assert.deepEqual(
    result.projects.map((p) => ({
      name: p.name,
      queuedTasks: p.queuedTasks,
      activeWorkers: p.activeWorkers,
    })),
    [{ name: "kmj-codebridge", queuedTasks: 5, activeWorkers: 1 }],
  );
  assert.equal(result.partial, true);
});

test("stale/future, forged or malformed samples cannot create healthy fleet", () => {
  const result = getLiveDashboardMetrics({
    now: NOW,
    authorizedDeviceIds: ["device1"],
    reports: [
      sample({ observedAtEpochMs: NOW - 90_000 }),
      sample({ observedAtEpochMs: NOW + 5_001 }),
      sample({ source: "client_report" }),
      sample({ deviceId: "../secrets" }),
      sample({ observedAtEpochMs: "recent" }),
    ],
  });
  assert.equal(result.activeDevices, null);
  assert.equal(result.fleetStatus, "UNKNOWN");
  assert.equal(result.notReportingDevices, 1);
});

test("missing or malformed queue is unknown, not a misleading zero", () => {
  const result = getLiveDashboardMetrics({
    now: NOW,
    authorizedDeviceIds: ["device1", "device2"],
    authorizedProjectGrants: [grant("device1"), grant("device2")],
    reports: [sample(), sample({ deviceId: "device2", queue: null })],
  });
  assert.equal(result.activeDevices, 2);
  assert.equal(result.projects[0].queueComplete, false);
  assert.equal(result.projects[0].queuedTasks, null);
  assert.equal(result.projects[0].activeWorkers, null);
  assert.equal(result.partial, true);
});

test("a self-labelled authenticated report without tenant grants is rejected", () => {
  const result = getLiveDashboardMetrics({
    now: NOW,
    reports: [sample({ queue: { queued: 345, running: 80 } })],
  });
  assert.equal(result.activeDevices, null);
  assert.equal(result.authorizedDevices, null);
  assert.equal(result.projects.length, 0);
  assert.equal(result.fleetStatus, "UNKNOWN");
  assert.equal(result.partial, true);
});

test("unknown grant scope is not treated as missing or offline", () => {
  const result = getLiveDashboardMetrics({ now: NOW, authorizedDeviceIds: [] });
  assert.equal(result.authorizedDevices, 0);
  assert.equal(result.notReportingDevices, 0);
  assert.equal(result.offlineDevices, null);
});

test("bounded telemetry rejects oversized and malformed input", () => {
  assert.throws(
    () =>
      getLiveDashboardMetrics({
        now: NOW,
        reports: new Array(129).fill(sample()),
      }),
    /DASHBOARD_TELEMETRY_INVALID_INPUT/,
  );
  assert.throws(
    () =>
      getLiveDashboardMetrics({ now: NOW, authorizedDeviceIds: ["../other"] }),
    /DASHBOARD_TELEMETRY_INVALID_INPUT/,
  );
  assert.throws(
    () => getLiveDashboardMetrics({ now: Number.NaN }),
    /DASHBOARD_TELEMETRY_INVALID_INPUT/,
  );
});

test("dashboard exposes only fresh authorized development progress, never invented release percent", () => {
  const result = getLiveDashboardMetrics({
    now: NOW,
    authorizedDeviceIds: ["device1"],
    authorizedProjectGrants: [grant("device1")],
    reports: [sample()],
    jobReceipts: [
      {
        source: "AUTHORIZED_PROJECT_JOB_RECEIPTS",
        deviceId: "device1",
        projectId: "kmj-codebridge",
        id: "test-job",
        state: "succeeded",
        observedAtEpochMs: NOW - 2000,
      },
    ],
  });
  assert.equal(result.developmentProgress.length, 1);
  assert.equal(result.developmentProgress[0].counts.running, 1);
  assert.equal(result.developmentProgress[0].counts.queued, 2);
  assert.equal(result.developmentProgress[0].recent[0].id, "test-job");
  assert.equal(
    result.developmentProgress[0].wholeProjectCompletionPercent,
    null,
  );
  assert.equal(
    result.developmentProgress[0].productionDeployment,
    "NOT_VERIFIED",
  );
});

test("dashboard never materializes progress for ungranted or stale agent reports", () => {
  const result = getLiveDashboardMetrics({
    now: NOW,
    authorizedDeviceIds: ["device1"],
    reports: [
      sample({ deviceId: "attacker" }),
      sample({ observedAtEpochMs: NOW - 90001 }),
    ],
  });
  assert.deepEqual(result.developmentProgress, []);
});

test("device presence cannot authorize unrelated project telemetry", () => {
  const result = getLiveDashboardMetrics({
    now: NOW,
    authorizedDeviceIds: ["device1"],
    authorizedProjectGrants: [grant("device1")],
    reports: [sample({ projectId: "other-project" })],
  });
  assert.equal(result.activeDevices, 1);
  assert.deepEqual(result.projects, []);
  assert.deepEqual(result.developmentProgress, []);
  assert.equal(result.partial, true);
  const unscoped = getLiveDashboardMetrics({
    now: NOW,
    authorizedDeviceIds: ["device1"],
    reports: [sample()],
  });
  assert.deepEqual(unscoped.projects, []);
  assert.equal(unscoped.partial, true);
});

test("one reporting device can have multiple independently authorized projects", () => {
  const result = getLiveDashboardMetrics({
    now: NOW,
    authorizedDeviceIds: ["device1"],
    authorizedProjectGrants: [
      grant("device1"),
      grant("device1", "kmj-omnidesk"),
    ],
    reports: [
      sample(),
      sample({ projectId: "kmj-omnidesk", queue: { queued: 4, running: 0 } }),
      sample({
        observedAtEpochMs: NOW - 2000,
        queue: { queued: 99, running: 9 },
      }),
    ],
  });
  assert.equal(result.activeDevices, 1);
  assert.equal(result.projects.length, 2);
  assert.equal(result.projects[0].queuedTasks, 2);
  assert.equal(result.projects[1].queuedTasks, 4);
  assert.equal(result.developmentProgress.length, 2);
  assert.equal(result.partial, false);
});
