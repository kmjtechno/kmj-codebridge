// GitHub is an optional integration. Never block the core gateway liveness
// endpoint on a remote GitHub or controller request, especially on cold starts.
// In-flight checks are coalesced and a stale result fails closed until proven.
export function createGitHubReadiness(probe, { now = Date.now, ttlMs = 30000 } = {}) {
  if (!probe) return () => false;

  let checkedAt = null;
  let ready = false;
  let inFlight = false;

  return function githubReady() {
    const current = now();
    if (
      !inFlight &&
      (checkedAt === null || current - checkedAt >= ttlMs)
    ) {
      checkedAt = current;
      ready = false;
      inFlight = true;
      void Promise.resolve()
        .then(probe)
        .then(
          () => {
            ready = true;
          },
          () => {
            ready = false;
          },
        )
        .finally(() => {
          inFlight = false;
        });
    }

    return ready;
  };
}
