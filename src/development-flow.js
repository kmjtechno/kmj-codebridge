import { redact } from "./jobs.js";

// This module summarizes *already authorized* device-local checkpoint + task
// observations. A checkpoint is a user/client-authored roadmap hint, never
// a trusted release attestation, an AI agent command, or a permission grant.
const REVISION = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

function safeText(value, max) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(value)
  )
    return null;
  return redact(value);
}

function safeList(value, limit, maxLength) {
  return Array.isArray(value)
    ? value.slice(0, limit).map((x) => safeText(x, maxLength)).filter(Boolean)
    : [];
}

function safeId(value) {
  return typeof value === "string" && ID.test(value) ? value : null;
}

export function buildDevelopmentFlow({
  device,
  project,
  lane,
  checkpoint = null,
  progress = null,
} = {}) {
  // Do not propagate untrusted cross-project data or malformed revisions.
  const stored =
    checkpoint?.exists === true &&
    REVISION.test(checkpoint.revision ?? "") &&
    (checkpoint.project === undefined || checkpoint.project === project) &&
    (checkpoint.lane === undefined || checkpoint.lane === lane);
  const blockers = stored ? safeList(checkpoint.blockers, 8, 160) : [];
  const nextSteps = stored ? safeList(checkpoint.nextSteps, 6, 180) : [];
  const objective = stored ? safeText(checkpoint.objective, 240) : null;
  const summary = stored ? safeText(checkpoint.summary, 1800) : null;
  const ready =
    progress?.taskTrackingAvailable === true
      ? safeId(progress.nextReadyTaskId)
      : null;
  const taskJournalAvailable = progress?.taskTrackingAvailable === true;
  const recommendedAction = blockers.length
    ? { code: "REVIEW_REPORTED_BLOCKERS", source: "CHECKPOINT_CLAIM" }
    : ready
      ? {
          code: "VERIFY_NEXT_READY_TASK",
          source: "AUTHORIZED_PROJECT_TASK_JOURNAL",
          taskId: ready,
        }
      : nextSteps.length
        ? { code: "REVERIFY_REPORTED_NEXT_STEP", source: "CHECKPOINT_CLAIM" }
        : { code: "CAPTURE_NEXT_MILESTONE", source: "WORKFLOW_DEFAULT" };

  return {
    version: 1,
    kind: "codebridge.development_flow",
    device,
    project,
    lane,
    roadmap: {
      status: stored ? "CHECKPOINT_SAVED_UNVERIFIED" : "NO_SAVED_CHECKPOINT",
      revision: stored ? checkpoint.revision : null,
      objective,
      summary,
      blockers,
      nextSteps,
      reportedNotVerified: true,
      source: stored ? "DEVICE_LOCAL_CHECKPOINT" : "NONE",
    },
    work: {
      taskJournalAvailable,
      nextReadyTaskId: ready,
      automatedExecutionVerified: false,
      // A claimed saved milestone must never mean it passed CI or shipped.
      releaseVerified: false,
    },
    recommendedAction,
    resume: {
      tool: "chat_workspace_open",
      lane,
      strategy: "ONE_SCOPED_READ_THEN_VERIFY_CHANGED_EVIDENCE",
      checkpointUpdate: "COMPACT_SESSION_SAVE_OR_LEGACY_CONTINUITY_SAVE",
      // The caller should use the digest returned by the host tool, not
      // invent a digest from these untrusted checkpoint statements.
    },
    safety: {
      ownerApprovalsRequired: true,
      noAutomaticProductionCutover: true,
      noChatAutoWake: true,
      noHostTranscriptAccess: true,
      sourceCIAndLiveDeploymentAreSeparate: true,
    },
  };
}
