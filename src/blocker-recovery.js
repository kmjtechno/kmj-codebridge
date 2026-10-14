// Deterministic, read-only, secret-free recovery plans for known KMJ CodeBridge blockers.
// No process is restarted, no lease is claimed and no credential is requested here.
// Optional client/CI/checkout observations are unverified caller assertions.
export const REQUIRED_LOCAL_TOOLS = Object.freeze([
  "local_model_status",
  "local_model_generate",
  "autopilot_local_draft",
]);

const SAFE_ACTIONS = Object.freeze({
  CLIENT_TOOL_NOT_ADVERTISED: {
    requiredCodeBridgeFeature: "HOSTED_MCP_TOOL_CAPTURE_DIAGNOSTIC",
    nextAction:
      "Compare installed client capture with hosted authenticated tools/list and the deployed agent schema; refresh app/catalog through supported approval workflow, never bypass OAuth.",
  },
  WORKER_CONFIGURED_NOT_STARTED: {
    requiredCodeBridgeFeature: "SUPERVISED_WORKER_HEALTH_AND_RECOVERY",
    nextAction:
      "Inspect fixed worker runtime status and enrolled agent revision; use only approved supervisor controls after version/config verification.",
  },
  NO_AUTONOMOUS_CODING_EXECUTOR: {
    requiredCodeBridgeFeature: "LEASE_BOUND_LOCAL_FIRST_CODING_EXECUTOR",
    nextAction:
      "Qualify an authorized isolated worker with actual lease, local/free model consent, allowlisted edits, exact-head gates and restart evidence; queue alone is not coding.",
  },
  CI_NO_RUNNER_STEPS: {
    requiredCodeBridgeFeature: "FIRST_PARTY_CI_CAPACITY_AND_BOOTSTRAP_DIAGNOSTIC",
    nextAction:
      "Distinguish GitHub Actions runner/account failure from source tests, preserve exact SHA, run only approved independent project QA without a paid runner.",
  },
  CI_TEST_FAILURE: {
    requiredCodeBridgeFeature: "EXACT_HEAD_CI_FAILURE_TRIAGE",
    nextAction:
      "Fetch exact-head failed-step logs, reproduce in isolated clean checkout and propose bounded repair with approved tests; do not waive checks.",
  },
  CHECKOUT_DIRTY: {
    requiredCodeBridgeFeature: "ISOLATED_SHA_PINNED_WORKTREE",
    nextAction:
      "Preserve all uncommitted changes and other agents; run independent QA only in an approved clean detached worktree at a pinned SHA.",
  },
});

function issue(code, evidence, source = "CODEBRIDGE_RUNTIME") {
  return {
    code,
    evidence,
    evidenceSource: source,
    ...SAFE_ACTIONS[code],
    noAutomaticProductionChange: true,
  };
}

/**
 * Can describe blocked capabilities even when a fresh MCP tool is NOT visible to
 * the chat app, because connection_doctor already exists in older clients.
 *
 * @param {object} input
 * @returns {object} bounded advice, not an executing autopilot controller
 */
export function inspectBlockers({
  clientVisibleTools = null,
  workerConfiguration = {},
  workerStarted = null,
  ciObservation = "unknown",
  checkoutState = "unknown",
} = {}) {
  if (
    clientVisibleTools !== null &&
    (!Array.isArray(clientVisibleTools) ||
      clientVisibleTools.length > 120 ||
      !clientVisibleTools.every(
        (name) =>
          typeof name === "string" &&
          /^[a-z][a-z0-9_]{0,63}$/.test(name),
      ))
  )
    throw new TypeError("INVALID_CLIENT_TOOL_OBSERVATION");
  if (
    !["unknown", "job-no-steps", "executed-test-fail", "checks-pending", "passed"].includes(
      ciObservation,
    ) ||
    !["unknown", "dirty", "clean"].includes(checkoutState)
  )
    throw new TypeError("INVALID_BLOCKER_OBSERVATION");

  const blockers = [];
  const missingClientTools =
    clientVisibleTools === null
      ? null
      : REQUIRED_LOCAL_TOOLS.filter((name) => !clientVisibleTools.includes(name));
  if (missingClientTools !== null && missingClientTools.length)
    blockers.push(
      issue(
        "CLIENT_TOOL_NOT_ADVERTISED",
        { missingTools: missingClientTools },
        "CALLER_CLIENT_TOOL_SNAPSHOT",
      ),
    );

  const workers = ["gate", "repair", "githubCiWatch", "localDraft"];
  const health = {};
  for (const kind of workers) {
    const configured = workerConfiguration[kind] === true;
    const observed =
      workerStarted === null || !Array.isArray(workerStarted[kind])
        ? null
        : workerStarted[kind].includes(true);
    health[kind] = { configured, loopStarted: observed };
    if (configured && observed !== true)
      blockers.push(
        issue("WORKER_CONFIGURED_NOT_STARTED", { worker: kind, observed }),
      );
  }
  // A local-draft loop writes proposals, not reviewed code. Gate/repair workers
  // do fixed jobs but do not imply an unbounded AI developer is available.
  blockers.push(
    issue("NO_AUTONOMOUS_CODING_EXECUTOR", {
      explicitVerifiedExecutor: false,
      note: "A configured worker or a queued task cannot prove AI coding.",
    }),
  );

  if (ciObservation === "job-no-steps")
    blockers.push(
      issue("CI_NO_RUNNER_STEPS", { observedStatus: ciObservation }, "CALLER_CI_OBSERVATION"),
    );
  if (ciObservation === "executed-test-fail")
    blockers.push(
      issue("CI_TEST_FAILURE", { observedStatus: ciObservation }, "CALLER_CI_OBSERVATION"),
    );
  if (checkoutState === "dirty")
    blockers.push(
      issue("CHECKOUT_DIRTY", { observedStatus: checkoutState }, "CALLER_CHECKOUT_OBSERVATION"),
    );

  return {
    mode: "READ_ONLY_ADVICE",
    status: blockers.length ? "ACTION_REQUIRED" : "INSPECTED",
    clientToolSnapshotProvided: clientVisibleTools !== null,
    clientModelToolsMissing: missingClientTools,
    workerHealth: health,
    blockers,
    safeIndependentWorkCanContinue: true,
    autonomousCodingProven: false,
    taskActuallyClaimed: false,
    freeProviderAutomaticallyConnected: false,
    productionOrBillingModified: false,
    note:
      "Actions require real project permissions, provider consent, an authorized worker and independent QA. Advice alone neither enqueues nor runs tasks.",
  };
}
