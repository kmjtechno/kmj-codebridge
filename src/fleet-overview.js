// Pure summaries; the gateway enforces account/device/project permissions.
const states = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
];

export function fleetLane(
  device,
  project,
  connectionStatus,
  autopilot,
  capacity,
) {
  const lane = {
    device,
    project,
    connectionStatus,
    operational: false,
    taskCounts: null,
    nextReadyTaskId: null,
    availableSlots: null,
    nextAction: "RESTORE_AGENT",
    wholeProjectCompletionPercent: null,
    productionReleaseReadiness: "NOT_EVALUATED",
  };
  if (connectionStatus !== "READY") return lane;
  if (!autopilot?.ok || !capacity?.ok) {
    lane.nextAction = "DIAGNOSE_AGENT_CAPABILITIES";
    return lane;
  }
  const counts = Object.fromEntries(
    states.map((state) => [
      state,
      Number.isSafeInteger(autopilot.value?.counts?.[state]) &&
      autopilot.value.counts[state] >= 0
        ? autopilot.value.counts[state]
        : 0,
    ]),
  );
  const cap = capacity.value;
  if (
    !Number.isSafeInteger(cap?.effectiveMaxConcurrent) ||
    !Number.isSafeInteger(cap?.activeJobs)
  ) {
    lane.nextAction = "DIAGNOSE_CAPACITY_REPORT";
    return lane;
  }
  const slots = Math.min(16, Math.max(0, cap.effectiveMaxConcurrent));
  lane.taskCounts = counts;
  lane.nextReadyTaskId = autopilot.value?.next?.id ?? null;
  lane.availableSlots = cap.blocked ? 0 : Math.max(0, slots - cap.activeJobs);
  lane.operational = !cap.blocked && slots > 0;
  if (!lane.operational) lane.nextAction = "RESOLVE_LICENSE_OR_RESOURCE_BLOCK";
  else if (lane.nextReadyTaskId && lane.availableSlots > 0)
    lane.nextAction = "CLAIM_APPROVED_READY_TASK";
  else if (counts.waiting > 0) lane.nextAction = "UNBLOCK_WAITING_TASKS";
  else if (cap.activeJobs > 0) lane.nextAction = "REVIEW_ACTIVE_JOBS";
  else if (counts.queued > 0) lane.nextAction = "RESOLVE_TASK_DEPENDENCIES";
  else lane.nextAction = "COMPILE_FIRST_APPROVED_MISSION";
  return lane;
}

export function fleetSummary(lanes, totalGrants) {
  return {
    totalAuthorizedProjects: totalGrants,
    shown: lanes.length,
    truncated: totalGrants > lanes.length,
    ready: lanes.filter((lane) => lane.connectionStatus === "READY").length,
    actionable: lanes.filter(
      (lane) => lane.nextAction === "CLAIM_APPROVED_READY_TASK",
    ).length,
    actualAvailableJobSlots: lanes.reduce(
      (sum, lane) => sum + (lane.availableSlots ?? 0),
      0,
    ),
    lanes,
    modeledOnly: false,
    noJobsStarted: true,
    wholeProjectCompletionPercent: null,
    commercialReleaseReadiness: "NOT_EVALUATED",
    note: "Capacity is signed-authorized job slots, not paid/free AI model access. This read-only status never starts a worker.",
  };
}
