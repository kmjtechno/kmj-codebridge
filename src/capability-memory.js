// This is a live *catalog and readiness hint*, not model memory, permission
// grant, proof of a callable agent tool, or a transcript of another chat.
const NAME = /^[a-z][a-z0-9_]{0,79}$/;
const RISK = new Set([
  "READ",
  "TEST",
  "EDIT",
  "GIT_WRITE",
  "SERVICE",
  "DEPLOY",
  "PRIVILEGED",
  "DESTRUCTIVE",
]);
const CATEGORY = Object.freeze({
  continuity:
    /^(chat_|compact_|context_|multi_chat_|coordination_|fast_context|checkpoint_)/,
  device:
    /^(list_devices|connection_|fleet_|workspace_|inspect_project|project_environment|policy_catalog|supervisor_device_)/,
  coding:
    /^(read_|write_|edit_|project_|search_code|hyperindex_|worktree_|run_quality_gate|run_project_command|git_)/,
  automation:
    /^(autopilot_|mission_|execution_capacity|hyperspeed_|verification_plan)/,
  browser: /^(browser_|render_codebridge_status)/,
  inference: /^(local_model_|model_route_)/,
  privileged: /^(supervisor_|audit_)/,
  github: /^github_/,
});

function boundedRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value)
    ? value
    : null;
}

export function buildCapabilityMemory({
  catalog,
  inspected,
  model,
  worker,
  updater,
} = {}) {
  const tools = Array.isArray(catalog?.tools)
    ? catalog.tools
        .filter(
          (entry) =>
            NAME.test(entry?.tool) &&
            RISK.has(entry?.risk) &&
            ["read", "write", "execute"].includes(entry?.access) &&
            typeof entry?.approvalRequired === "boolean",
        )
        .slice(0, 160)
    : null;
  const known = new Map();
  for (const tool of tools ?? []) {
    if (!known.has(tool.tool)) {
      known.set(tool.tool, {
        name: tool.tool,
        risk: tool.risk,
        approvalRequired: tool.approvalRequired,
      });
    }
  }
  const groups = {};
  for (const [category, expression] of Object.entries(CATEGORY)) {
    groups[category] = [...known.keys()].filter((name) =>
      expression.test(name),
    );
  }
  const listed = new Set(Object.values(groups).flat());
  groups.other = [...known.keys()].filter((name) => !listed.has(name));

  const modelReady =
    typeof model?.readyForOnDemandUse === "boolean"
      ? model.readyForOnDemandUse
      : null;
  const gateRunning =
    typeof worker?.workers?.gate?.loopStarted === "boolean"
      ? worker.workers.gate.loopStarted
      : null;
  const localDraftRunning =
    typeof worker?.workers?.localDraft?.loopStarted === "boolean"
      ? worker.workers.localDraft.loopStarted
      : null;
  const updaterInstalled =
    typeof updater?.service?.installed === "boolean"
      ? updater.service.installed
      : null;
  return {
    status: tools === null ? "UNAVAILABLE" : "CATALOG_REPORTED",
    source: "AUTHORIZED_PROJECT_DEVICE_POLICY",
    advisoryOnly: true,
    callableVerified: false,
    permissionGrant: false,
    persistedModelMemory: false,
    advertisedToolCount: known.size,
    advertisedToolsByCategory: groups,
    approvalRequiredRisks: [
      ...new Set(
        [...known.values()]
          .filter((tool) => tool.approvalRequired)
          .map((tool) => tool.risk),
      ),
    ].sort(),
    runtime: {
      connected:
        typeof inspected?.connection === "string"
          ? inspected.connection === "connected"
          : null,
      version:
        typeof inspected?.version === "string" &&
        /^\d+\.\d+\.\d+$/.test(inspected.version)
          ? inspected.version
          : null,
      revision: boundedRevision(inspected?.runtimeRevision?.commit),
      localModelReady: modelReady,
      gateLoopStarted: gateRunning,
      localDraftLoopStarted: localDraftRunning,
      updaterInstalled,
      autonomousCodingLiveVerified: false,
      rootShellGrantedVerified: false,
    },
    refreshBeforeSensitiveAction: [
      "inspect_project",
      "policy_catalog",
      "supervisor_status",
    ],
  };
}
