// Native project-scoped progress snapshot. Never claim commercial release
// or whole-repository completion from a subset of CodeBridge job/task journals.
const TASK_STATES = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"];
const JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"];
function count(source, allowed) {
  return Object.fromEntries(allowed.map((name) => [
    name,
    Number.isSafeInteger(source?.[name]) && source[name] >= 0 ? source[name] : 0,
  ]));
}

export function buildProjectProgress({ sessions, autopilotState } = {}) {
  const jobs = count(sessions?.summary, JOB_STATES);
  const taskTrackingAvailable = autopilotState !== null && autopilotState !== undefined;
  const tasks = taskTrackingAvailable ? count(autopilotState?.counts, TASK_STATES) : null;
  const total = tasks ? Object.values(tasks).reduce((sum, value) => sum + value, 0) : 0;
  const terminal = tasks ? tasks.succeeded + tasks.failed + tasks.cancelled : 0;
  const jobFailures = jobs.failed + jobs.timed_out + jobs.interrupted;
  const attention = [];
  if (!taskTrackingAvailable) attention.push("AUTOPILOT_JOURNAL_UNAVAILABLE");
  if (taskTrackingAvailable && total === 0) attention.push("NO_TRACKED_TASKS");
  if (tasks?.waiting) attention.push("TASKS_WAITING");
  if (tasks?.failed) attention.push("FAILED_TASKS");
  if (jobFailures) attention.push("RECENT_OR_HISTORIC_JOB_FAILURES");
  if (sessions?.archivedJobs) attention.push("ARCHIVED_JOBS_NOT_INCLUDED_IN_LIVE_SUMMARY");
  return {
    measurement: "CODEBRIDGE_PROJECT_SCOPED_JOURNALS_ONLY",
    taskTrackingAvailable,
    tasks,
    trackedTasksTotal: taskTrackingAvailable ? total : null,
    trackedTasksTerminalPercent: total ? Math.round((10000 * terminal) / total) / 100 : null,
    trackedTasksSucceededPercent: total ? Math.round((10000 * tasks.succeeded) / total) / 100 : null,
    nextReadyTaskId: autopilotState?.next?.id ?? null,
    jobs: {
      counts: jobs,
      totalVisible: Object.values(jobs).reduce((sum, value) => sum + value, 0),
      archivedCount: sessions?.archivedJobs ?? 0,
      recent: (sessions?.jobs ?? []).slice(0, 20).map((job) => ({
        id: job.id,
        gate: job.gate,
        state: job.state,
        exitCode: job.exitCode ?? null,
        endedAt: job.endedAt ?? null,
      })),
    },
    attention,
    wholeProjectCompletionPercent: null,
    commercialReleaseReadiness: "NOT_EVALUATED",
    evidenceNote: "Task percentages represent only persisted scoped journal tasks, not code coverage, release gates, delivery deadlines, or real project completion.",
  };
}
