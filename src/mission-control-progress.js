// No inference, polling or deployment. Derived only from authenticated
// device observations and verifiable job receipts.
const STATES = new Set(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_AGE_MS = 90_000;
function natural(n) {
  return Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000 ? n : null;
}
export function verifiedDevelopmentProgress({
  device, project, agentReport, jobReceipts = [], now = Date.now(),
} = {}) {
  if (!DEVICE.test(device ?? "") || !DEVICE.test(project ?? "") ||
      !Number.isSafeInteger(now) || now < 0 ||
      !Array.isArray(jobReceipts) || jobReceipts.length > 100)
    throw new Error("INVALID_PROGRESS_REQUEST");
  const observed = agentReport?.observedAtEpochMs;
  const fresh = agentReport?.source === "authenticated_agent_reports" &&
    agentReport.deviceId === device && agentReport.projectId === project &&
    Number.isSafeInteger(observed) &&
    observed > now - MAX_AGE_MS && observed <= now + 5000;
  const queue = fresh ? agentReport.queue : null;
  const counts = Object.fromEntries([...STATES].map(
    key => [key, queue ? natural(queue[key]) : null]
  ));
  const accepted = jobReceipts.filter(j =>
    j?.source === "AUTHORIZED_PROJECT_JOB_RECEIPTS" &&
    j?.deviceId === device && j?.projectId === project &&
    STATES.has(j.state) &&
    typeof j.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(j.id) &&
    Number.isSafeInteger(j.observedAtEpochMs) &&
    j.observedAtEpochMs <= now + 5000 &&
    j.observedAtEpochMs > now - MAX_AGE_MS
  ).sort((a,b) => b.observedAtEpochMs - a.observedAtEpochMs).slice(0,6)
   .map(({id,state,observedAtEpochMs}) => ({id,state,observedAtEpochMs}));
  return {
    source: fresh ? "FRESH_AUTHORIZED_AGENT" : "NOT_VERIFIED",
    device, project,
    observedAtEpochMs: fresh ? observed : null,
    counts,
    recent: accepted,
    runningConfirmed: fresh && counts.running !== null && counts.running > 0,
    wholeProjectCompletionPercent: null,
    modelExecuting: "NOT_VERIFIED",
    cloudFreeAllowance: "NOT_VERIFIED",
    backgroundWorker24x7: "NOT_VERIFIED",
    productionDeployment: "NOT_VERIFIED",
    note: "Queued is not executed; successful job receipts do not prove a deployed release.",
  };
}
