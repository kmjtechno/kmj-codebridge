// Read-only mission activity from existing, project-scoped CodeBridge job receipts.
// The gateway authenticates user/device/project before forwarding list_project_jobs.
// We never expose job output, arguments, environment, arbitrary metadata or secrets.
const JOB_ID = /^[A-Za-z0-9-]{1,128}$/;
const GATE = /^[A-Za-z0-9_.:-]{1,100}$/;
const STATES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
const MAX_ITEMS = 6;

function boundedTime(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && stamp >= 0
    ? new Date(stamp).toISOString()
    : null;
}

export function buildMissionActivity({ project, jobs, now = Date.now() }) {
  const unavailable = {
    source: "AUTHORIZED_PROJECT_JOB_RECEIPTS",
    status: "UNAVAILABLE",
    observedAt: null,
    items: [],
    hasMore: null,
  };
  if (
    typeof project !== "string" ||
    !jobs?.ok ||
    jobs.value?.project !== project ||
    !Array.isArray(jobs.value.jobs) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return unavailable;

  const input = jobs.value;
  const total =
    Number.isSafeInteger(input.total) && input.total >= 0 ? input.total : null;
  // A project mismatch is not a partial result: it is an invalid response.
  if (total === null || input.jobs.length > 6) return unavailable;

  const items = [];
  for (const job of input.jobs) {
    if (
      !job ||
      typeof job.id !== "string" ||
      !JOB_ID.test(job.id) ||
      typeof job.gate !== "string" ||
      !GATE.test(job.gate) ||
      !STATES.has(job.state)
    )
      return unavailable;
    const at =
      job.state === "queued"
        ? boundedTime(job.queuedAt)
        : job.state === "running"
          ? boundedTime(job.startedAt)
          : boundedTime(job.endedAt);
    if (!at || Date.parse(at) > now + 5000) return unavailable;
    items.push({
      id: job.id,
      gate: job.gate,
      state: job.state,
      at,
      exitCode:
        Number.isSafeInteger(job.exitCode) &&
        job.exitCode >= -255 &&
        job.exitCode <= 255
          ? job.exitCode
          : null,
    });
  }
  return {
    source: "AUTHORIZED_PROJECT_JOB_RECEIPTS",
    status: "AVAILABLE",
    observedAt: new Date(now).toISOString(),
    items,
    hasMore: input.nextCursor !== null || total > items.length,
  };
}
