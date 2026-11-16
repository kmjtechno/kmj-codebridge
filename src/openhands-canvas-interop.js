// Source-only interoperability profile for OpenHands Agent Canvas.
// This module never contacts OpenHands, registers MCP tools, starts agents,
// requests a model, authorizes a device, or modifies production.
export const KMJ_CODEBRIDGE_MCP_URL = "https://kmjtechno.com/mcp";
const SCHEMA = "kmj.openhands.agent-canvas.handoff.v1";

function invalid(code) {
  throw new Error("OPENHANDS_" + code);
}

// Owner-provided booleans are planning hints, NOT cryptographic attestations.
// The actual MCP OAuth handshake and sandbox must be independently verified.
export function createOpenHandsCanvasHandoff({
  endpoint = KMJ_CODEBRIDGE_MCP_URL,
  runtime = "isolated-docker",
  task = "review",
  sandboxVerified = false,
  oauthVerified = false,
  freeModelRouteVerified = false,
  ownerApproved = false,
  enableProductionWrites = false,
} = {}) {
  if (endpoint !== KMJ_CODEBRIDGE_MCP_URL)
    invalid("UNAPPROVED_MCP_ENDPOINT");
  if (runtime !== "isolated-docker") invalid("UNSAFE_RUNTIME");
  if (!["review", "implementation"].includes(task))
    invalid("UNAPPROVED_TASK");
  if (
    [sandboxVerified, oauthVerified, freeModelRouteVerified, ownerApproved, enableProductionWrites]
      .some((value) => typeof value !== "boolean")
  ) invalid("INVALID_APPROVAL_FLAGS");
  if (enableProductionWrites) invalid("PRODUCTION_WRITE_DENIED");

  const blockers = [];
  if (!sandboxVerified) blockers.push("SANDBOX_NOT_VERIFIED");
  if (!oauthVerified) blockers.push("MCP_OAUTH_NOT_VERIFIED");
  if (!freeModelRouteVerified) blockers.push("FREE_MODEL_ROUTE_NOT_VERIFIED");
  if (!ownerApproved) blockers.push("OWNER_TASK_APPROVAL_MISSING");

  return {
    schema: SCHEMA,
    status: blockers.length === 0 ? "READY_FOR_MANUAL_PILOT" : "PILOT_BLOCKED",
    blockers,
    sourceOnly: true,
    executionAttempted: false,
    productionMutation: false,
    mcp: {
      name: "KMJ CodeBridge",
      transport: "Streamable HTTP",
      url: KMJ_CODEBRIDGE_MCP_URL,
      auth: "interactive OAuth in Agent Canvas; never embed credentials",
    },
    agentCanvas: {
      configureAt: "Customize > MCP Servers",
      runtime,
      task,
      approval: "manual per task and privileged operation",
      models: "owner-verified free-only route; no paid or cloud fallback",
      projectAccess: "mount only a disposable or feature-branch workspace",
    },
    verification: [
      "Use Agent Canvas MCP connection health check",
      "Independently verify OAuth, device and project-scoped permissions",
      "Prove zero-cost model billing/route and Docker isolation",
      "Run read-only CodeBridge workspace checks before any bounded writes",
      "Check exact-head tests and review the PR before deploy",
    ],
  };
}
