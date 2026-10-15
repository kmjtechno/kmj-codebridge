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
    reports: [
      sample({ queue: { queued: 99, running: 9 }, observedAtEpochMs: NOW - 10_000 }),
      sample(),
      sample({ deviceId: "device2", projectId: "kmj-codebridge", queue: { queued: 3, running: 0 } }),
      sample({ deviceId: "stranger", queue: { queued: 700, running: 0 } }),
    ],
  });
  assert.equal(result.activeDevices, 2);
  assert.equal(result.authorizedDevices, 3);
  assert.equal(result.notReportingDevices, 1);
  assert.equal(result.offlineDevices, null);
  assert.deepEqual(result.projects.map((p) => ({
    name: p.name,
    queuedTasks: p.queuedTasks,
    activeWorkers: p.activeWorkers,
  })), [{ name: "kmj-codebridge", queuedTasks: 5, activeWorkers: 1 }]);
  assert.equal(result.partial, false);
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
    reports: [
      sample(),
      sample({ deviceId: "device2", queue: null }),
    ],
  });
  assert.equal(result.activeDevices, 2);
  assert.equal(result.projects[0].queueComplete, false);
  assert.equal(result.projects[0].queuedTasks, null);
  assert.equal(result.projects[0].activeWorkers, null);
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
    () => getLiveDashboardMetrics({ now: NOW, reports: new Array(129).fill(sample()) }),
    /DASHBOARD_TELEMETRY_INVALID_INPUT/,
  );
  assert.throws(
    () => getLiveDashboardMetrics({ now: NOW, authorizedDeviceIds: ["../other"] }),
    /DASHBOARD_TELEMETRY_INVALID_INPUT/,
  );
  assert.throws(
    () => getLiveDashboardMetrics({ now: Number.NaN }),
    /DASHBOARD_TELEMETRY_INVALID_INPUT/,
  );
});
