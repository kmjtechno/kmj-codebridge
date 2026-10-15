// Pure presentation of already verified, project-scoped observations.
//
// Never use implicit process cwd or shell commands here: those can observe the
// wrong checkout or expose unredacted worktree/task information to UI callers.
// The authenticated host collects bounded evidence and passes safe counters.
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/;
const CI_STATES = new Set(["PASS", "FAIL", "RUNNING", "BLOCKED"]);

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
}

export function getLiveActivityStatus({
  git = null,
  autopilot = null,
  ci = null,
  now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("LIVE_ACTIVITY_INVALID_TIME");
  const branch =
    typeof git?.branch === "string" &&
    BRANCH.test(git.branch) &&
    !git.branch.includes("..") &&
    !git.branch.includes("//")
      ? git.branch
      : null;
  const changes = safeCount(git?.uncommittedChanges);
  const running = safeCount(autopilot?.counts?.running);
  const verifiedCi =
    ci?.source === "verified_ci_result" &&
    CI_STATES.has(ci?.state) &&
    typeof ci?.headSha === "string" &&
    SHA.test(ci.headSha);

  return {
    timestamp: new Date(now).toISOString(),
    measurement: "PROJECT_SCOPED_VERIFIED_INPUTS_ONLY",
    gitBranch: branch,
    uncommittedChanges: changes,
    activeTaskCount: running,
    // Never return raw task descriptions, code snippets, lease tokens or
    // private journal entries in general-purpose telemetry.
    runningTasks: null,
    ciHealth: verifiedCi ? ci.state : "UNKNOWN",
    ciHeadSha: verifiedCi ? ci.headSha : null,
    statusReport:
      branch === null && running === null && !verifiedCi
        ? "NO_VERIFIED_ACTIVITY_OBSERVATIONS"
        : "PARTIAL_VERIFIED_ACTIVITY_OBSERVATIONS",
    evidenceRequired: "Authenticated project collector and exact-head CI",
  };
}
