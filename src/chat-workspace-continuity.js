// Reconcile durable compact sessions and legacy chat-continuity records.
// These are caller-authored, *untrusted* checkpoint hints, never approvals.
const REVISION = /^[a-f0-9]{64}$/;

const scoped = (data, scope) =>
  data &&
  typeof data === "object" &&
  data.project === scope.project &&
  data.lane === scope.lane;

const boundedText = (value, limit) =>
  typeof value === "string" && value.length <= limit;
const boundedList = (value, count, length) =>
  Array.isArray(value) &&
  value.length <= count &&
  value.every((item) => boundedText(item, length));

function currentCompact(result, scope) {
  const value = result?.ok ? result.value : null;
  if (!scoped(value, scope)) return null;
  // Never propagate arbitrary fields from an empty, untrusted record.
  if (value.exists === false) return { exists: false, revision: null };
  if (
    value.exists !== true ||
    typeof value.revision !== "string" ||
    !REVISION.test(value.revision) ||
    !boundedText(value.summary, 1800) ||
    !(value.objective == null || boundedText(value.objective, 240)) ||
    !boundedList(value.blockers, 8, 240) ||
    !boundedList(value.nextSteps, 6, 420)
  )
    return null;
  // Return only bounded, validated display fields, never caller-supplied grants.
  return {
    exists: true,
    revision: value.revision,
    objective: value.objective ?? null,
    summary: value.summary,
    blockers: [...value.blockers],
    nextSteps: [...value.nextSteps],
  };
}

function currentLegacy(result, scope) {
  const value = result?.ok ? result.value : null;
  if (!scoped(value, scope) || value.version !== 1) return null;
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) return null;
  if (typeof value.revision !== "string" || !REVISION.test(value.revision))
    return null;
  if (typeof value.summary !== "string" || value.summary.length > 1800)
    return null;
  if (!Array.isArray(value.blockers) || value.blockers.length > 8) return null;
  const blockers = value.blockers.filter(
    (item) => typeof item === "string" && item.length <= 240,
  );
  if (blockers.length !== value.blockers.length) return null;
  const nextSteps =
    typeof value.next === "string" && value.next.length <= 420
      ? [value.next]
      : [];
  return {
    exists: true,
    revision: value.revision,
    objective: null,
    summary: value.summary,
    blockers,
    nextSteps,
  };
}

export function needsLegacyContinuity(compact, scope) {
  return currentCompact(compact, scope)?.exists !== true;
}

export function resolveChatWorkspaceCheckpoint({
  compact,
  legacy,
  scope,
} = {}) {
  const primary = currentCompact(compact, scope);
  const older = currentLegacy(legacy, scope);
  return {
    checkpoint: primary?.exists === true ? primary : (older ?? primary),
    checkpointSaveTool: compact?.ok
      ? "compact_session_save"
      : legacy?.ok
        ? "chat_continuity_save"
        : null,
  };
}
