import { setTimeout as delay } from "node:timers/promises";

// A journal mutation may release the next dependency-ready, admin-approved
// task. Wake installed workers without creating a second scheduler, while
// keeping periodic polls for running jobs and expired leases.
// No arbitrary command, API call or model inference is authorized here.
export async function waitForTaskChange(journal, intervalMs, signal) {
  if (signal.aborted) return;
  if (!journal || typeof journal.subscribe !== "function") {
    await delay(intervalMs, undefined, { signal });
    return;
  }
  const timeout = new AbortController();
  let resolveWake;
  const wake = new Promise((resolve) => {
    resolveWake = resolve;
  });
  const unsubscribe = journal.subscribe(() => resolveWake());
  const onAbort = () => resolveWake();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([
      wake,
      delay(intervalMs, undefined, { signal: timeout.signal }).catch(
        (error) => {
          if (error?.name !== "AbortError") throw error;
        },
      ),
    ]);
  } finally {
    timeout.abort();
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}
