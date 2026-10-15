// First-party, read-only GitHub Actions execution evidence. A failed workflow
// with no recorded job steps is not an application-test result. Never infer
// the provider root cause or substitute local checks for hosted branch policy.
export function classifyActionsJob(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : null;
  const stepCount = steps?.length ?? null;
  let execution = "STEPS_UNKNOWN";
  if (job?.status !== "completed") execution = "NOT_COMPLETED";
  else if (stepCount === 0) execution = "NO_STEPS_RECORDED";
  else if (stepCount > 0) execution = "STEPS_RECORDED";
  return {
    id: Number.isSafeInteger(job?.id) ? job.id : null,
    status: job?.status ?? null,
    conclusion: job?.conclusion ?? null,
    recordedStepCount: stepCount,
    execution,
    // Setup/checkout steps are not the same as an executed application test.
    applicationTestsVerified: false,
  };
}

export function diagnoseActionsRun({ run, jobs, totalCount, expectedHeadSha }) {
  if (
    !run ||
    run.head_sha !== expectedHeadSha ||
    !/^[a-f0-9]{40}$/i.test(expectedHeadSha ?? "")
  ) throw new Error("CI_HEAD_MISMATCH");

  const complete =
    Number.isInteger(totalCount) &&
    totalCount > 0 &&
    totalCount <= 100 &&
    Array.isArray(jobs) &&
    jobs.length === totalCount &&
    jobs.every((job) => Number.isSafeInteger(job?.id) && job.id > 0);
  const observed = (Array.isArray(jobs) ? jobs : [])
    .slice(0, 100)
    .map(classifyActionsJob);
  const noSteps = observed.filter(
    (j) => j.status === "completed" &&
      j.conclusion === "failure" &&
      j.execution === "NO_STEPS_RECORDED",
  ).length;
  const withSteps = observed.filter(
    (j) => j.execution === "STEPS_RECORDED",
  ).length;
  let classification = "INCOMPLETE_EVIDENCE";
  if (complete && run.status !== "completed") classification = "RUN_PENDING";
  else if (complete && run.conclusion === "failure" && noSteps === totalCount)
    classification = "FAILED_WITH_ZERO_JOB_STEPS";
  else if (complete && run.conclusion === "failure" && noSteps > 0)
    classification = "FAILED_MIXED_EXECUTION_EVIDENCE";
  else if (complete && run.conclusion === "failure" && withSteps > 0)
    classification = "FAILED_WITH_RECORDED_STEPS";
  else if (complete && run.conclusion === "success")
    classification = "SUCCESS_REQUIRES_FULL_PR_GATES";
  else if (complete) classification = "OTHER_COMPLETED_STATE";

  return {
    headSha: expectedHeadSha,
    runId: Number.isSafeInteger(run.id) ? run.id : null,
    runStatus: run.status ?? null,
    runConclusion: run.conclusion ?? null,
    classification,
    evidenceComplete: complete,
    jobCount: observed.length,
    zeroStepFailedJobs: noSteps,
    recordedStepJobs: withSteps,
    jobs: observed,
    providerRootCauseVerified: false,
    codeTestsPassed: false,
    authorizedFallback:
      classification === "FAILED_WITH_ZERO_JOB_STEPS" ||
      classification === "FAILED_MIXED_EXECUTION_EVIDENCE"
        ? "RUN_PREAPPROVED_LOCAL_GATES_IN_ISOLATED_SHA_PINNED_WORKTREE"
        : "REVIEW_EXACT_FAILED_STEPS_OR_PENDING_CHECKS",
    localEvidenceIsHostedCi: false,
    mergeAuthorization: "BLOCKED_UNTIL_REQUIRED_EXACT_HEAD_GATES_VERIFIED",
    noPaidRunnerRequired: true,
  };
}
