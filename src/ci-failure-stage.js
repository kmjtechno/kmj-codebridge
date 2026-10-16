// Classify only GitHub Actions job.step failure evidence. A failed step name
// is a signal for triage, NOT proof of root cause or authorization for a fix.
// Untrusted step strings are never stored in the persistent Autopilot journal.
const STAGES = Object.freeze({
  FORMAT: "FORMAT_STEP_FAILED",
  TEST: "TEST_STEP_FAILED",
  BUILD: "BUILD_STEP_FAILED",
  DEPENDENCY: "DEPENDENCY_STEP_FAILED",
  ENVIRONMENT: "ENVIRONMENT_STEP_FAILED",
});

export function classifyCiFailureStage(job) {
  if (!job || !Array.isArray(job.steps) || job.steps.length > 100)
    return "FAILED_STAGE_UNKNOWN";
  const stages = new Set();
  for (const step of job.steps) {
    if (
      !step ||
      step.status !== "completed" ||
      step.conclusion !== "failure" ||
      typeof step.name !== "string" ||
      step.name.length > 120
    )
      continue;
    const name = step.name.toLowerCase().trim();
    if (/\b(prettier|formatting|format check|lint|eslint)\b/.test(name))
      stages.add(STAGES.FORMAT);
    else if (/\b(test|tests|testing|ctest|vitest|jest)\b/.test(name))
      stages.add(STAGES.TEST);
    else if (/\b(build|compile|compilation|typecheck|type-check)\b/.test(name))
      stages.add(STAGES.BUILD);
    else if (/\b(install dependencies|npm ci|pnpm install|yarn install)\b/.test(name))
      stages.add(STAGES.DEPENDENCY);
    else if (/\b(checkout|setup node|set up node|setup python|upload artifact)\b/.test(name))
      stages.add(STAGES.ENVIRONMENT);
    else stages.add("FAILED_STAGE_UNKNOWN");
  }
  if (stages.size === 0) return "FAILED_STAGE_UNKNOWN";
  if (stages.size > 1) return "MULTIPLE_FAILED_STEPS";
  return [...stages][0];
}
