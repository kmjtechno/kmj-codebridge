/**
 * Idempotent asynchronous shutdown coordinator.
 *
 * Every shutdown attempt receives the same promise. A rejected cleanup is
 * never retried implicitly or reported as successful: the owner retains its
 * existing restart/fencing responsibility until the failure is reviewed.
 */
export function singleFlightClose(close) {
  if (typeof close !== "function")
    throw new TypeError("SHUTDOWN_CLOSE_FUNCTION_REQUIRED");
  let pending = null;
  return function closeOnce() {
    if (!pending) pending = Promise.resolve().then(close);
    return pending;
  };
}
