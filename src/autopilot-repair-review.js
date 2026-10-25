import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fail } from "./errors.js";
import { reviewHarnessGuard, reviewHandoff } from "./agent-harness-guard.js";
import { redact } from "./jobs.js";
import {
  parseRepairTask,
  verifyRepairCandidate,
} from "./autopilot-repair-worker.js";
import { parseCodingTask } from "./autopilot-coding-worker.js";

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
  const repairRecipes = project?.autopilotRepairWorker?.recipes;
  const codingConfig = project?.autopilotCodingWorker;
  const codingRecipes =
    codingConfig?.enabled === true &&
    codingConfig?.localProcessingApproved === true
      ? codingConfig.recipes
      : null;
  if (!project?.writable || (!repairRecipes && !codingRecipes))
    fail("AUTOPILOT_REPAIR_NOT_CONFIGURED");
  const task = journal.get(taskId, project.id);
  if (
    task.state !== "waiting" ||
    task.lastReason !== "VERIFIED_PATCH_AWAITING_REVIEW" ||
    task.checkpoint?.next !== "VERIFIED_PATCH_AWAITING_REVIEW"
  )
    fail("AUTOPILOT_REPAIR_NOT_VERIFIED");
  const repairSpec = repairRecipes ? parseRepairTask(task.key, repairRecipes) : null;
  const codingSpec = codingRecipes ? parseCodingTask(task.key, codingRecipes) : null;
  const spec = repairSpec ?? codingSpec;
  if (!spec) fail("AUTOPILOT_REPAIR_RECIPE_UNAVAILABLE");
  const recipeConfig = repairSpec ? repairRecipes[spec.recipe] : codingRecipes[spec.recipe];
  let evidence;
  try {
    evidence = JSON.parse(task.checkpoint.summary);
  } catch {
    fail("AUTOPILOT_REPAIR_EVIDENCE_INVALID");
  }
  if (
    evidence?.status !== "VERIFIED_PATCH_AWAITING_REVIEW" ||
    !/^(?:repair|coding)_[a-f0-9]{32}$/.test(evidence.laneId ?? "") ||
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
  const matches = lanes
    .status(project.id, project.root)
    .lanes.filter((lane) => lane.laneId === evidence.laneId);
  if (
    matches.length !== 1 ||
    matches[0].head !== spec.expectedHead ||
    !matches[0].dirty
  )
    fail("AUTOPILOT_REPAIR_LANE_CHANGED");
  const lane = matches[0];
  const patch = verifyRepairCandidate(lane.path, recipeConfig.paths);
  if (
    !patch ||
    patch.sha256 !== evidence.patchSha256 ||
    patch.bytes !== evidence.patchBytes ||
    JSON.stringify(patch.files) !== JSON.stringify(evidence.files)
  )
    fail("AUTOPILOT_REPAIR_PATCH_CHANGED");
  let preview = null;
  let previewTruncated = false;
  let scannedPatch = null;
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
    const refreshed = verifyRepairCandidate(lane.path, recipeConfig.paths);
    if (
      !refreshed ||
      refreshed.sha256 !== evidence.patchSha256 ||
      refreshed.bytes !== evidence.patchBytes ||
      Buffer.byteLength(raw) !== evidence.patchBytes ||
      createHash("sha256").update(Buffer.from(raw)).digest("hex") !==
        evidence.patchSha256
    )
      fail("AUTOPILOT_REPAIR_PATCH_CHANGED");
    scannedPatch = raw;
    preview = redact(raw).slice(0, MAX_PREVIEW_CHARS);
    previewTruncated = raw.length > MAX_PREVIEW_CHARS;
  }
  // ECC-style review guard is advisory, never an automatic publish permit.
  // Without explicit patch preview, only paths are classified; no silent
  // assumption that the patch was content-scanned.
  const guard = reviewHarnessGuard({
    files: patch.files,
    patch: scannedPatch,
  });
  const handoff = reviewHandoff({
    expectedHead: spec.expectedHead,
    patchSha256: patch.sha256,
    verificationJobId: evidence.verificationJobId,
    guard,
  });
  return {
    task: task.id,
    project: project.id,
    recipe: spec.recipe,
    candidateType: repairSpec ? "deterministic-repair" : "local-first-code",
    laneId: evidence.laneId,
    expectedHead: spec.expectedHead,
    files: patch.files,
    patchBytes: patch.bytes,
    patchSha256: patch.sha256,
    verificationJobId: evidence.verificationJobId,
    state: "VERIFIED_PATCH_AWAITING_REVIEW",
    reviewGuard: guard,
    handoff,
    preview,
    previewTruncated,
    publishStatus: "NOT_PUBLISHED",
    nextAction: "REVIEW_PATCH_AND_PUBLISH_THROUGH_AUTHORIZED_PR_FLOW",
  };
}
