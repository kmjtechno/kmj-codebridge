import { planSmartModelRoute } from "./smart-model-router.js";

// Compatibility adapter for older AI-router callers. This produces an advisory
// decision only; the host must independently verify authenticated provider
// provenance and enforce zero spend before any request is sent.
//
// The previous implementation selected a cloud endpoint based only on prompt
// length and used CommonJS exports inside a type=module package, which was
// both an execution defect and an unsafe assumption about cloud approval.
export function routeAIRequest({
  models,
  task,
  state = {},
  nowMs = Date.now(),
} = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("AI_ROUTER_INVALID_TASK");
  }
  const normalized = {
    strategy: "local-first",
    capability: "coding",
    privateCode: true,
    cloudApproved: false,
    ...task,
  };
  return planSmartModelRoute({
    models,
    task: normalized,
    state,
    nowMs,
  });
}
