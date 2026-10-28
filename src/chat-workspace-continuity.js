// Reconcile durable compact sessions and legacy chat-continuity records.
// These are caller-authored, *untrusted* checkpoint hints, never approvals.
const REVISION = /^[a-f0-9]{64}$/;

const scoped = (data, scope) =>
  data &&
  typeof data === "object" &&
  data.project === scope.project &&
  data.lane === scope.lane;

function currentCompact(result, scope) {
  const value = result?.ok ? result.value : null;
  if (!scoped(value, scope)) return null;
  if (value.exists === false) return value;
  if (value.exists !== true || !REVISION.test(value.revision ?? ""))
    return null;
  if (
    typeof value.summary !== "string" ||
    !Array.isArray(value.blockers) ||
    !Array.isArray(value.nextSteps)
  )
    return null;
  return value;
}

function currentLegacy(result, scope) {
  const value = result?.ok ? result.value : null;
  if (!scoped(value, scope) || value.version !== 1) return null;
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1)
    return null;
  if (!REVISION.test(value.revision ?? "")) return null;
  if (typeof value.summary !== "string" || value.summary.length > 1800)
    return null;
  if (!Array.isArray(value.blockers) || value.blockers.length > 8)
    return null;
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
