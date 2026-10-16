import { setTimeout as delay } from "node:timers/promises";

// Wake a configured worker promptly when durable task state changes, while
// retaining bounded polling for lease recovery and external process results.
// This does not execute arbitrary tasks or contact an AI API.
export async function waitForTaskChange(journal, intervalMs, signal) {
  if (signal.aborted) return;
  if (!journal || typeof journal.subscribe !== "function") {
    await delay(intervalMs, undefined, { signal });
    return;
  }
  let resolveWake;
  const wake = new Promise((resolve) => {
    resolveWake = resolve;
  });
  const unsubscribe = journal.subscribe(() => resolveWake());
  try {
    await Promise.race([
      wake,
      delay(intervalMs, undefined, { signal }).catch((error) => {
        if (error?.name !== "AbortError") throw error;
      }),
    ]);
  } finally {
    unsubscribe();
  }
}
