import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";
import {
  parseRepairTask,
  verifyRepairCandidate,
} from "./autopilot-repair-worker.js";

const MAX_PREVIEW_CHARS = 24000;

// Never run a formatter, stage, commit or push. Read a candidate only when
// current worktree bytes still match a persisted post-verification SHA-256.
export function reviewRepairCandidate({
  project,
  journal,
  lanes,
  taskId,
  includePatch = false,
}) {
  if (!project?.writable || !project.autopilotRepairWorker?.recipes)
    fail("AUTOPILOT_REPAIR_NOT_CONFIGURED");
  const task = journal.get(taskId, project.id);
  if (
    task.state !== "waiting" ||
    task.lastReason !== "VERIFIED_PATCH_AWAITING_REVIEW" ||
    task.checkpoint?.next !== "VERIFIED_PATCH_AWAITING_REVIEW"
  )
    fail("AUTOPILOT_REPAIR_NOT_VERIFIED");
  const spec = parseRepairTask(task.key, project.autopilotRepairWorker.recipes);
  if (!spec) fail("AUTOPILOT_REPAIR_RECIPE_UNAVAILABLE");
  let evidence;
  try {
    evidence = JSON.parse(task.checkpoint.summary);
  } catch {
    fail("AUTOPILOT_REPAIR_EVIDENCE_INVALID");
  }
  if (
    evidence?.status !== "VERIFIED_PATCH_AWAITING_REVIEW" ||
    !/^repair_[a-f0-9]{32}$/.test(evidence.laneId ?? "") ||
    evidence.expectedHead !== spec.expectedHead ||
    !Array.isArray(evidence.files) ||
    evidence.files.length > 20 ||
    !Number.isInteger(evidence.patchBytes) ||
    evidence.patchBytes < 1 ||
    evidence.patchBytes > 96 * 1024 ||
    !/^[a-f0-9]{64}$/.test(evidence.patchSha256 ?? "") ||
    typeof evidence.verificationJobId !== "string"
  )
    fail("AUTOPILOT_REPAIR_EVIDENCE_INVALID");
  const matches = lanes.status(project.id, project.root).lanes.filter(
    (lane) => lane.laneId === evidence.laneId,
  );
  if (
    matches.length !== 1 ||
    matches[0].head !== spec.expectedHead ||
    !matches[0].dirty
  )
    fail("AUTOPILOT_REPAIR_LANE_CHANGED");
  const lane = matches[0];
  const patch = verifyRepairCandidate(
    lane.path,
    project.autopilotRepairWorker.recipes[spec.recipe].paths,
  );
  if (
    !patch ||
    patch.sha256 !== evidence.patchSha256 ||
    patch.bytes !== evidence.patchBytes ||
    JSON.stringify(patch.files) !== JSON.stringify(evidence.files)
  )
    fail("AUTOPILOT_REPAIR_PATCH_CHANGED");
  let preview = null;
  let previewTruncated = false;
  if (includePatch) {
    const raw = execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "HEAD",
      ],
      {
        cwd: lane.path,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 100000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    const refreshed = verifyRepairCandidate(
      lane.path,
      project.autopilotRepairWorker.recipes[spec.recipe].paths,
    );
    if (
      !refreshed ||
      refreshed.sha256 !== evidence.patchSha256 ||
      refreshed.bytes !== evidence.patchBytes ||
      Buffer.byteLength(raw) !== evidence.patchBytes ||
      createHash("sha256").update(Buffer.from(raw)).digest("hex") !==
        evidence.patchSha256
    )
      fail("AUTOPILOT_REPAIR_PATCH_CHANGED");
    preview = redact(raw).slice(0, MAX_PREVIEW_CHARS);
    previewTruncated = raw.length > MAX_PREVIEW_CHARS;
  }
  return {
    task: task.id,
    project: project.id,
    recipe: spec.recipe,
    laneId: evidence.laneId,
    expectedHead: spec.expectedHead,
    files: patch.files,
    patchBytes: patch.bytes,
    patchSha256: patch.sha256,
    verificationJobId: evidence.verificationJobId,
    state: "VERIFIED_PATCH_AWAITING_REVIEW",
    preview,
    previewTruncated,
    publishStatus: "NOT_PUBLISHED",
    nextAction: "REVIEW_PATCH_AND_PUBLISH_THROUGH_AUTHORIZED_PR_FLOW",
  };
}
