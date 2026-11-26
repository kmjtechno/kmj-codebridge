import { isDeepStrictEqual } from "node:util";
import { planNativeCodingPilot } from "./native-coding-pilot-plan.js";

// Prepare a candidate in memory only. Callers must validate against the
// signed runtime schema and use the protected operator installation path.
// Never serialize the candidate into a tool response or diagnostic log.
export function stageDisabledNativePilot(config, scope) {
  const plan = planNativeCodingPilot(scope);
  if (plan.status !== "PROPOSAL_ONLY_NOT_ACTIVATED")
    return { status: plan.status };
  const matches = Array.isArray(config?.projects)
    ? config.projects.filter((project) => project?.id === plan.project)
    : [];
  if (matches.length !== 1 || matches[0].writable !== true)
    return { status: "EXACT_WRITABLE_PROJECT_REQUIRED" };

  const project = matches[0];
  if (
    project.gates !== undefined &&
    (!project.gates ||
      typeof project.gates !== "object" ||
      Array.isArray(project.gates))
  )
    return { status: "GATES_INVALID" };

  if (
    (Object.hasOwn(project, "autopilotCodingWorker") &&
      !isDeepStrictEqual(project.autopilotCodingWorker, plan.worker)) ||
    (Object.hasOwn(project.gates ?? {}, plan.gateName) &&
      !isDeepStrictEqual(project.gates[plan.gateName], plan.gate))
  )
    return { status: "EXISTING_CODING_CONFIG_REVIEW_REQUIRED" };

  const candidate = structuredClone(config);
  const target = candidate.projects.find((item) => item.id === plan.project);
  target.gates ??= {};
  target.gates[plan.gateName] = plan.gate;
  target.autopilotCodingWorker = plan.worker;

  return {
    status: "DISABLED_CANDIDATE_ONLY",
    changed: !isDeepStrictEqual(config, candidate),
    candidate,
  };
}
