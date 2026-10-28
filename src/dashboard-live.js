import { verifiedDevelopmentProgress } from "./mission-control-progress.js";
// Read-only, injected dashboard snapshot. The caller must supply observations
// from a tenant-authorized agent collector; this module does not poll, infer,
// or authenticate devices. Never display a sample fixture as production truth.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_REPORTS = 128;
const FRESH_MS = 90_000;
const CLOCK_SKEW_MS = 5_000;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
}

export function getLiveDashboardMetrics({
  reports = [],
  authorizedDeviceIds = null,
  jobReceipts = [],
  now = Date.now(),
} = {}) {
  if (
    !Array.isArray(reports) ||
    reports.length > MAX_REPORTS ||
    !Array.isArray(jobReceipts) ||
    jobReceipts.length > 100 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    (authorizedDeviceIds !== null &&
      (!Array.isArray(authorizedDeviceIds) ||
        authorizedDeviceIds.length > MAX_REPORTS ||
        authorizedDeviceIds.some(
          (id) => typeof id !== "string" || !ID.test(id),
        )))
  )
    throw new Error("DASHBOARD_TELEMETRY_INVALID_INPUT");

  const authorized =
    authorizedDeviceIds === null ? null : new Set(authorizedDeviceIds);
  const fresh = new Map();
  for (const report of reports) {
    // The status must be produced by an authenticated backend, never by an
    // untrusted browser or a client-declared health string.
    if (
      !report ||
      report.source !== "authenticated_agent_reports" ||
      typeof report.deviceId !== "string" ||
      !ID.test(report.deviceId) ||
      !Number.isSafeInteger(report.observedAtEpochMs) ||
      report.observedAtEpochMs > now + CLOCK_SKEW_MS ||
      report.observedAtEpochMs <= now - FRESH_MS ||
      // Missing grant scope must fail closed, never accept a self-labelled
      // "authenticated" report from an unscoped caller.
      authorized === null ||
      !authorized.has(report.deviceId)
    )
      continue;

    const previous = fresh.get(report.deviceId);
    if (!previous || previous.observedAtEpochMs < report.observedAtEpochMs)
      fresh.set(report.deviceId, report);
  }

  const projects = new Map();
  for (const report of fresh.values()) {
    const id = report.projectId;
    if (typeof id !== "string" || !ID.test(id)) continue;
    const tasks = report.queue;
    const queued = count(tasks?.queued);
    const running = count(tasks?.running);
    const existing = projects.get(id) ?? {
      name: id,
      status: "REPORTING",
      queuedTasks: null,
      activeWorkers: null,
      sampledDevices: 0,
      queueComplete: true,
    };
    existing.sampledDevices += 1;
    if (queued === null || running === null) {
      existing.queueComplete = false;
    } else {
      existing.queuedTasks = (existing.queuedTasks ?? 0) + queued;
      existing.activeWorkers = (existing.activeWorkers ?? 0) + running;
    }
    projects.set(id, existing);
  }

  // If even one active reporter did not include a project queue, the sum is
  // partial. A zero would falsely imply the queue is empty.
  const summaries = [...projects.values()].map((p) => ({
    ...p,
    queuedTasks: p.queueComplete ? p.queuedTasks : null,
    activeWorkers: p.queueComplete ? p.activeWorkers : null,
  }));

  return {
    timestamp: new Date(now).toISOString(),
    platform: "KMJ CodeBridge",
    measurement: "FRESH_AUTHORIZED_AGENT_REPORTS_ONLY",
    activeDevices:
      fresh.size === 0 && authorized?.size !== 0 ? null : fresh.size,
    offlineDevices: null,
    authorizedDevices: authorized?.size ?? null,
    notReportingDevices:
      authorized === null ? null : Math.max(0, authorized.size - fresh.size),
    fleetStatus: fresh.size > 0 ? "REPORTING" : "UNKNOWN",
    aiRoutingEngine: {
      activeMode: null,
      primary: null,
      fallback: null,
      note: "Provider health and the selected model require separate verified inference evidence.",
    },
    projects: summaries.sort((a, b) => a.name.localeCompare(b.name)),
    // True live status needs a fresh authenticated source and device grant.
    // This is not a whole-project percentage or a background poller.
    developmentProgress: [...fresh.values()]
      .filter(
        (report) =>
          typeof report.projectId === "string" && ID.test(report.projectId),
      )
      .map((report) =>
        verifiedDevelopmentProgress({
          device: report.deviceId,
          project: report.projectId,
          agentReport: report,
          jobReceipts,
          now,
        }),
      )
      .filter((entry) => entry.source === "FRESH_AUTHORIZED_AGENT")
      .sort((a, b) => a.device.localeCompare(b.device)),
    partial: fresh.size === 0 || summaries.some((p) => !p.queueComplete),
    note: "Live means a recent backend-authorized agent report. Missing evidence is unknown, not healthy or offline.",
  };
}
