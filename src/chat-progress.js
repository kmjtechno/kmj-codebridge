// Opt in to request-scoped SSE only for scoped read-only tools.
const PROGRESS_TOOLS = new Set([
  "render_codebridge_status",
  "compact_work_brief",
  "fast_context",
  "fast_read_batch",
  "context_resume",
  "chat_workspace_open",
  "git_diff",
  "read_file_range",
  "list_project_jobs",
]);
// JSON remains the default. A progress token requests notifications, not
// permission to perform an operation or proof that it succeeded.
function validToken(token) {
  return (
    (typeof token === "string" && token.length > 0 && token.length <= 128) ||
    Number.isSafeInteger(token)
  );
}

export function progressRequested(request, accept) {
  if (
    request?.method !== "tools/call" ||
    !PROGRESS_TOOLS.has(request.params?.name) ||
    !validToken(request.params?._meta?.progressToken) ||
    typeof accept !== "string"
  )
    return false;
  const types = accept.split(",").map((value) => value.trim().toLowerCase());
  return (
    types.includes("application/json") && types.includes("text/event-stream")
  );
}

export async function notifyProgress(extra, progress, message) {
  const progressToken = extra?._meta?.progressToken;
  if (
    !validToken(progressToken) ||
    extra.signal?.aborted ||
    typeof extra.sendNotification !== "function"
  )
    return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, message },
    });
  } catch {
    // A disconnected or incompatible host must not change tool semantics.
  }
}
