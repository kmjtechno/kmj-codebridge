import { createHash } from "node:crypto";
import { redact } from "./jobs.js";

// A bounded, portable snapshot of already-authorized local CodeBridge facts.
// It is NOT an AI chat transcript, live file watcher, release gate or a clone
// of host-specific ChatGPT Work capabilities.
const safePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\\:\x00-\x1f]/.test(value) &&
  !value.startsWith("/") &&
  value
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        !/^(?:\.git|\.env(?:\..*)?|\.ssh|node_modules|\.codebridge-.*)$/i.test(
          part,
        ),
    );
const safeLabel = (value, limit = 100) =>
  typeof value === "string" && value.length <= limit ? redact(value) : null;
const safeNames = (names, limit = 24) =>
  Array.isArray(names)
    ? names
        .filter(
          (name) =>
            typeof name === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name),
        )
        .slice(0, limit)
    : [];

export function buildChatWorkspaceOpen({
  device,
  project,
  lane,
  writable,
  environment,
  explorer,
  progress,
  checkpoint,
  browser,
  browserCapability = "UNAVAILABLE",
  checkpointSaveTool = "compact_session_save",
  qualityGates,
  capabilityMemory = null,
  ifNoneMatch = null,
}) {
  const entries = Array.isArray(explorer?.entries)
    ? explorer.entries
        .filter(
          (entry) =>
            safePath(entry?.path) &&
            ["file", "directory"].includes(entry.type) &&
            Number.isInteger(entry.depth) &&
            entry.depth >= 0 &&
            entry.depth <= 2,
        )
        .slice(0, 40)
        .map(({ path, type, depth }) => ({ path, type, depth }))
    : [];
  const recent = Array.isArray(progress?.jobs?.recent)
    ? progress.jobs.recent.slice(0, 8).map((j) => ({
        id: safeLabel(j.id, 128),
        gate: safeLabel(j.gate),
        state: safeLabel(j.state, 32),
        exitCode: Number.isInteger(j.exitCode) ? j.exitCode : null,
      }))
    : [];
  const exists = checkpoint?.exists === true;
  const payload = {
    kind: "codebridge.chat_workspace_open",
    version: 1,
    device,
    project,
    lane,
    source: "AUTHORIZED_DEVICE_LOCAL_PROJECT",
    workspace: {
      writable: typeof writable === "boolean" ? writable : null,
      explorer: {
        status: Array.isArray(explorer?.entries) ? "AVAILABLE" : "UNAVAILABLE",
        entries,
        truncated:
          Array.isArray(explorer?.entries) &&
          typeof explorer.truncated === "boolean"
            ? explorer.truncated || explorer.entries.length > 40
            : null,
      },
      environment: environment
        ? {
            stacks: safeNames(environment.stacks),
            frameworks: safeNames(environment.frameworks),
            packageManagers: safeNames(environment.packageManagers),
          }
        : null,
      qualityGates: safeNames(qualityGates),
    },
    progress: progress
      ? {
          measurement: "SCOPED_JOURNALS_ONLY",
          taskTrackingAvailable: progress.taskTrackingAvailable === true,
          trackedTasksTotal: progress.trackedTasksTotal ?? null,
          trackedTasksSucceededPercent:
            progress.trackedTasksSucceededPercent ?? null,
          nextReadyTaskId: safeLabel(progress.nextReadyTaskId, 128),
          attention: safeNames(progress.attention, 12),
          recentJobs: recent,
        }
      : null,
    checkpoint: {
      status: checkpoint ? (exists ? "SAVED" : "NONE") : "UNAVAILABLE",
      revision: exists ? checkpoint.revision : null,
      objective: exists ? safeLabel(checkpoint.objective, 240) : null,
      summary: exists ? safeLabel(checkpoint.summary, 1800) : null,
      blockers: exists ? checkpoint.blockers.slice(0, 8).map(redact) : [],
      nextSteps: exists ? checkpoint.nextSteps.slice(0, 6).map(redact) : [],
      reportedNotVerified: true,
    },
    browser: browser
      ? {
          localFirst: true,
          chromiumInstalled: browser.fidelity?.installed === true,
          moliInstalled: browser.fast?.installed === true,
          launchVerified: false,
          visualQa:
            browser.plan?.visualQa === "chromium"
              ? "chromium"
              : "blocked_no_local_browser",
        }
      : null,
    capabilities: {
      liveCatalog: capabilityMemory,
      browserRuntime: browser ? "AVAILABLE" : browserCapability,
      checkpointSaveTool: [
        "compact_session_save",
        "chat_continuity_save",
      ].includes(checkpointSaveTool)
        ? checkpointSaveTool
        : null,
    },
    nextTools: [
      "project_tree",
      "project_file_info",
      ...(["compact_session_save", "chat_continuity_save"].includes(
        checkpointSaveTool,
      )
        ? [checkpointSaveTool]
        : []),
      "chat_lane_reserve",
      "list_project_jobs",
      ...(browser ? ["browser_runtime_status"] : []),
      "verification_plan",
    ],
    hostLimitations: {
      chatTranscriptCaptured: false,
      hostContextWindowExtended: false,
      inactiveChatWakeSupported: false,
      automaticUserApproval: false,
      wholeProjectCompletionVerified: false,
    },
  };
  // Integrity and ifNoneMatch are scoped to this bounded snapshot, not proof
  // the repository, network or the chat host is unchanged.
  const revision = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  if (ifNoneMatch === revision)
    return {
      kind: payload.kind,
      device,
      project,
      lane,
      revision,
      unchanged: true,
      source: payload.source,
      chatTranscriptCaptured: false,
    };
  return { ...payload, revision, unchanged: false };
}
