// Worker-loop handles are not evidence of running jobs, inference or uptime.
const KINDS = ["gate", "repair", "githubCiWatch", "localDraft", "coding"];

export function buildMissionWorkers({ device, project, report }) {
  const unavailable = {
    source: "AUTHORIZED_AGENT_WORKER_HANDLES",
    status: "UNAVAILABLE",
    items: [],
  };
  const value = report?.value;
  if (
    report?.ok !== true ||
    value?.device !== device ||
    value?.project !== project ||
    value?.evidence !== "ACTIVE_AGENT_WORKER_HANDLES" ||
    value?.processAvailable !== true
  )
    return unavailable;

  const items = [];
  for (const kind of KINDS) {
    const worker = value.workers?.[kind];
    if (
      typeof worker?.configured !== "boolean" ||
      typeof worker?.loopStarted !== "boolean"
    )
      return unavailable;
    items.push({
      kind,
      configured: worker.configured,
      loopStarted: worker.loopStarted,
    });
  }
  return {
    source: "AUTHORIZED_AGENT_WORKER_HANDLES",
    status: "AVAILABLE",
    items,
  };
}
