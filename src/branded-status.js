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
      git: git?.ok === true,
      tasks: autopilot?.ok === true,
      capacity: capacity?.ok === true,
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
    const branch = /^## ([A-Za-z0-9._/-]{1,120})/.exec(firstLine);
    brief.git = {
      branch: branch ? branch[1] : null,
      dirty: /\n\s*(?:M|A|D|R|\?\?|U)/m.test(git.value.status),
    };
  }
  if (autopilot?.ok) {
    brief.tasks = Object.fromEntries(
      STATES.map((key) => [
        key,
        Number.isSafeInteger(autopilot.value?.counts?.[key]) &&
        autopilot.value.counts[key] >= 0
          ? autopilot.value.counts[key]
          : 0,
      ]),
    );
    brief.nextReadyTaskId = cleanId(autopilot.value?.next?.id);
  }
  if (
    capacity?.ok &&
    Number.isSafeInteger(capacity.value?.effectiveMaxConcurrent) &&
    Number.isSafeInteger(capacity.value?.activeJobs)
  ) {
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

export function compactStatusText(value) {
  const status = value.action === "NEXT_READY_TASK" ? "READY" : "REVIEW";
  return [
    "KMJ CodeBridge — " + status,
    "Project: " + value.project,
    "Next: " + (value.nextReadyTaskId ?? value.action),
    "Authorized slots: " + (value.availableAuthorizedSlots ?? "unavailable"),
    "Whole-product release: NOT_EVALUATED",
  ].join("\n");
}

// Avoid a runtime fetch of any private asset. This is the existing approved
// CodeBridge icon pinned to a reviewed immutable public GitHub commit.
// No arbitrary HTML, JS or source values are interpolated into the card.
export const KMJ_STATUS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:system-ui,Arial,sans-serif}
body{margin:0;color:CanvasText;background:Canvas}
article{padding:14px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:12px;max-width:520px}
header{display:flex;align-items:center;gap:12px}
img{height:48px;width:48px;object-fit:contain;background:transparent}
h2{margin:0;font-size:17px} small{opacity:.7}
dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:6px;margin:14px 0 0;font-size:13px}
dt{opacity:.7}dd{margin:0;overflow-wrap:anywhere}
</style></head><body><article role="status" aria-label="KMJ CodeBridge progress">
<header><img alt="Approved KMJ TECHNO icon" src="${APPROVED_ICON_URL}"><div><h2>KMJ CodeBridge</h2><small>KMJ TECHNO · INNOVATE | BUILD | SCALE</small></div></header>
<dl><dt>Project</dt><dd id="project">Authorized project</dd>
<dt>Next task</dt><dd id="next">Use a verified status tool</dd>
<dt>Job slots</dt><dd id="slots">Unknown</dd>
<dt>Release</dt><dd>Independent approval required</dd></dl></article>
<script>
(function(){
 const set=(id,value)=>{const element=document.getElementById(id);if(element&&value!==undefined&&value!==null)element.textContent=String(value).slice(0,128)};
 const render=(data)=>{
   if(!data||data.product!=="KMJ CodeBridge")return;
   set("project",data.project);
   set("next",data.nextReadyTaskId||data.action);
   set("slots",data.availableAuthorizedSlots);
 };
 try{render(window.openai?.toolOutput)}catch{}
 window.addEventListener("message",(event)=>{
   if(event.source!==window.parent)return;
   if(event.data?.method!=="ui/notifications/tool-result")return;
   render(event.data?.params?.structuredContent);
 });
})();
</script></body></html>`;
