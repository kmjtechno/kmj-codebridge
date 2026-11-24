import { KMJ_MISSION_CONTROL_HTML } from "./mission-control-ui.js";
// Read-only, token-lean project state for every MCP chat client.
// The graphical card is opt-in and available only to MCP Apps UI hosts.
export const KMJ_STATUS_RESOURCE_URI = "ui://kmj-codebridge/status-v1.html";
export const APPROVED_ICON_URL =
  "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/6ec9f2d352115beb37d68408c45dc750a5088787/plugin/assets/icon.png";
const STATES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
];
const cleanId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    ? value
    : null;

export function compactWorkBrief({
  device,
  project,
  git,
  autopilot,
  capacity,
}) {
  const brief = {
    product: "KMJ CodeBridge",
    device,
    project,
    evidence: {
      git: false,
      tasks: false,
      capacity: false,
    },
    git: null,
    tasks: null,
    nextReadyTaskId: null,
    availableAuthorizedSlots: null,
    action: "CHECK_PROJECT_READ_ACCESS",
    wholeProjectCompletionPercent: null,
    commercialReleaseReadiness: "NOT_EVALUATED",
    paidModelUsageEstimate: "NOT_MEASURED",
  };
  if (git?.ok && typeof git.value?.status === "string") {
    const firstLine = git.value.status.split("\n", 1)[0] ?? "";
    const branch = /^## ([A-Za-z0-9._/-]{1,120})/.exec(
      firstLine.split("...", 1)[0],
    );
    brief.evidence.git = true;
    brief.git = {
      branch: branch ? branch[1] : null,
      dirty: git.value.status
        .split("\n")
        .slice(1)
        .some(
          (line) => /^[ MADRCUT?!]{2} /.test(line) && !line.startsWith("!!"),
        ),
    };
  }
  if (
    autopilot?.ok &&
    STATES.every(
      (key) =>
        Number.isSafeInteger(autopilot.value?.counts?.[key]) &&
        autopilot.value.counts[key] >= 0,
    )
  ) {
    brief.evidence.tasks = true;
    brief.tasks = Object.fromEntries(
      STATES.map((key) => [key, autopilot.value.counts[key]]),
    );
    brief.nextReadyTaskId = cleanId(autopilot.value?.next?.id);
  }
  if (
    capacity?.ok &&
    Number.isSafeInteger(capacity.value?.effectiveMaxConcurrent) &&
    capacity.value.effectiveMaxConcurrent >= 0 &&
    Number.isSafeInteger(capacity.value?.activeJobs) &&
    capacity.value.activeJobs >= 0 &&
    typeof capacity.value.blocked === "boolean"
  ) {
    brief.evidence.capacity = true;
    const cap = capacity.value;
    brief.availableAuthorizedSlots = cap.blocked
      ? 0
      : Math.max(0, Math.min(16, cap.effectiveMaxConcurrent) - cap.activeJobs);
  }
  if (brief.tasks && brief.availableAuthorizedSlots !== null) {
    brief.action =
      brief.nextReadyTaskId && brief.availableAuthorizedSlots > 0
        ? "NEXT_READY_TASK"
        : brief.tasks.waiting > 0
          ? "UNBLOCK_WAITING_TASK"
          : brief.tasks.queued > 0
            ? "RESOLVE_DEPENDENCIES"
            : brief.availableAuthorizedSlots === 0
              ? "CHECK_JOB_CAPACITY"
              : "NO_TRACKED_READY_TASK";
  }
  return brief;
}

const receiptLabels = {
  queued: "QUEUED",
  running: "RUNNING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  timed_out: "TIMED OUT",
  interrupted: "INTERRUPTED",
};

function activityText(activity) {
  if (
    activity?.source !== "AUTHORIZED_PROJECT_JOB_RECEIPTS" ||
    activity.status !== "AVAILABLE" ||
    !Array.isArray(activity.items)
  )
    return ["Recent jobs: NOT VERIFIED"];
  const lines = ["Recent project job receipts (snapshot):"];
  for (const item of activity.items.slice(0, 3)) {
    if (!item || !Object.hasOwn(receiptLabels, item.state)) continue;
    const gate = cleanId(item.gate);
    if (!gate) continue;
    const code = Number.isSafeInteger(item.exitCode)
      ? " · exit " + item.exitCode
      : "";
    lines.push("- [" + receiptLabels[item.state] + "] " + gate + code);
  }
  if (lines.length === 1) lines.push("- No valid receipts in snapshot");
  if (activity.hasMore || activity.items.length > 3)
    lines.push("- More receipts available in project jobs");
  return lines;
}

export function compactStatusText(value) {
  const status = value.action === "NEXT_READY_TASK" ? "READY" : "REVIEW";
  const lines = [
    "KMJ CodeBridge — " + status,
    "Project: " + (cleanId(value.project) ?? "unavailable"),
    "Device: " + (cleanId(value.device) ?? "unavailable"),
    "Next: " +
      (cleanId(value.nextReadyTaskId ?? value.action) ?? "unavailable"),
    "Authorized slots: " + (value.availableAuthorizedSlots ?? "unavailable"),
  ];
  lines.push(...activityText(value.activity));
  lines.push("Whole-product release: NOT_EVALUATED");
  return lines.join("\n");
}

// The approved, immutable KMJ brand icon remains pinned. Keep the existing
// ui:// status-v1 resource identifier for backwards-compatible MCP clients.
// Mission Control never renders untrusted HTML from tool data.
export const KMJ_STATUS_HTML = KMJ_MISSION_CONTROL_HTML.replaceAll(
  "__CODEBRIDGE_APPROVED_ICON_URL__",
  APPROVED_ICON_URL,
);
