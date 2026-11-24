// Client-facing protocol extensions, kept outside core authorization.
//
// Every MCP client receives the same tools, schemas, annotations and errors.
// OAuth tools advertise the standard top-level `securitySchemes` field and keep
// the same value in `_meta.securitySchemes` for older OpenAI clients. Runtime
// authorization challenges use `_meta["mcp/www_authenticate"]`. Authorization
// decisions never depend on which client is connected; these helpers only
// describe decisions already made.
import { oauthChallenge } from "./auth.js";

// Native chat activity labels are descriptive only. "Returned" never means
// that a job succeeded, a device connected, a write applied or a PR merged.
const activityGroups = [
  [
    /^(?:connection_|list_devices$|account_diagnostics$)/,
    "Checking device connection",
  ],
  [/^(?:github_|git_)/, "Checking Git and GitHub"],
  [
    /^(?:run_quality_gate$|verification_|ide_run_project_task$)/,
    "Requesting verification",
  ],
  [
    /^(?:read_|list_directory$|project_tree$|search_code$|fast_read|fast_context$|repo_|inspect_project$)/,
    "Inspecting project source",
  ],
  [
    /^(?:write_|edit_file$|create_project_directory$|move_project_file$|copy_project_file$)/,
    "Requesting guarded file changes",
  ],
  [/^supervisor_/, "Requesting Supervisor operation"],
  [
    /^(?:autopilot_|mission_|execution_capacity$)/,
    "Checking engineering workflow",
  ],
  [
    /^(?:browser_|ide_|run_project_command$|get_job_status$|cancel_job$)/,
    "Requesting project operation",
  ],
  [
    /^(?:render_codebridge_status$|project_progress$|fleet_overview$|compact_work_brief$)/,
    "Checking engineering status",
  ],
  [
    /^(?:chat_|compact_session_|multi_chat_sync$|context_resume$|coordination_)/,
    "Requesting project continuity",
  ],
  [
    /^(?:model_|freellmapi_|local_model_|skill_)/,
    "Requesting model or skill information",
  ],
];

export function toolActivityMeta(name) {
  if (typeof name !== "string") return {};
  const invoking =
    activityGroups.find(([pattern]) => pattern.test(name))?.[1] ??
    "Processing CodeBridge request";
  return {
    "openai/toolInvocation/invoking": invoking + "…",
    "openai/toolInvocation/invoked": "CodeBridge response received",
  };
}

export function toolSecurityMeta(oauth, access, name) {
  const activity = toolActivityMeta(name);
  if (!oauth) return { _meta: activity };
  const securitySchemes = [
    { type: "oauth2", scopes: [`codebridge:${access}`] },
  ];
  return {
    securitySchemes,
    _meta: {
      securitySchemes,
      ...activity,
    },
  };
}

export function insufficientScopeMeta(oauth, user, access) {
  const scope = `codebridge:${access}`;
  if (!oauth || user.grantedScopes.includes(scope)) return {};
  return {
    _meta: {
      "mcp/www_authenticate": [
        oauthChallenge(oauth, scope) +
          ', error="insufficient_scope", error_description="Authorize the requested CodeBridge scope to continue"',
      ],
    },
  };
}
