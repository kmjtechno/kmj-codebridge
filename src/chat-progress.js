// Opt in to request-scoped SSE only for the read-only status pilot.
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
    request.params?.name !== "render_codebridge_status" ||
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
