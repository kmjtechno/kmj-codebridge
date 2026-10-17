import { CodeBridgeError } from "./errors.js";

// GitHub is an optional integration. Never block the core gateway liveness
// endpoint on a remote GitHub or controller request, especially on cold starts.
//
// In-flight checks are coalesced. A refresh keeps the last *fresh* success
// readable while it runs (stale-while-revalidate), bounded by `graceMs`: once
// the last success is older than ttlMs + graceMs, readiness fails closed until
// a new probe proves it again. A failed probe fails closed immediately.
//
// Before this, every refresh reset readiness to false before probing, so any
// /healthz request arriving more than ttlMs after the previous one reported
// githubReady=false even when GitHub was healthy (issue #274).
//
// status() is safe to publish: it carries only a fixed state, an age in whole
// seconds and a fixed error code — never a URL, repository, token or message.
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

export function readinessErrorCode(error) {
  if (error instanceof CodeBridgeError && ERROR_CODE.test(error.code))
    return error.code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError")
    return "GITHUB_TIMEOUT";
  if (error instanceof TypeError) return "GITHUB_UNREACHABLE";
  return "GITHUB_PROBE_FAILED";
}

// Public GitHub reads share a small unauthenticated hourly budget.
// On a shared free-tier Render egress IP, one health check every five minutes
// can consume 12 of the 60 anonymous API requests/hour before real user reads.
// Revalidate this OPTIONAL health signal at most four times/hour instead.
// Fail closed as soon as a real probe fails; never change the freshness of
// actual PR/CI reads, their authorization, or cached response data.
export function githubReadinessOptions(github) {
  return github?.publicReadOnly
    ? { ttlMs: 900000, graceMs: 30000, rateLimitCooldownMs: 3600000 }
    : {};
}

export function createGitHubReadiness(
  probe,
  {
    now = Date.now,
    ttlMs = 30000,
    graceMs = ttlMs,
    timeoutMs = 15000,
    rateLimitCooldownMs = 0,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  if (!probe) {
    const disabled = () => false;
    disabled.status = () => ({ state: "disabled" });
    return disabled;
  }

  let checkedAt = null;
  let lastSuccessAt = null;
  let lastResultAt = null;
  let lastError = null;
  let inFlight = false;
  let rateLimitedUntil = null;

  const withTimeout = () =>
    new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        const error = new Error("GitHub readiness probe timed out");
        error.name = "TimeoutError";
        reject(error);
      }, timeoutMs);
      timer?.unref?.();
      Promise.resolve()
        .then(probe)
        .then(resolve, reject)
        .finally(() => clearTimer(timer));
    });

  const refreshIfDue = (current) => {
    if (
      inFlight ||
      (rateLimitedUntil !== null && current < rateLimitedUntil) ||
      (checkedAt !== null && current - checkedAt < ttlMs)
    )
      return;
    checkedAt = current;
    inFlight = true;
    void withTimeout()
      .then(
        () => {
          lastSuccessAt = now();
          lastError = null;
          rateLimitedUntil = null;
        },
        (error) => {
          lastSuccessAt = null;
          lastError = readinessErrorCode(error);
          // The anonymous quota usually resets over an hourly window.
          // While exhausted, keep reporting FAILED; retrying every five
          // minutes only burns requests and cannot prove a healthy bridge.
          // This cooldown is enabled solely for public-read-only mode.
          if (lastError === "GITHUB_RATE_LIMIT" && rateLimitCooldownMs > 0)
            rateLimitedUntil = now() + rateLimitCooldownMs;
        },
      )
      .finally(() => {
        lastResultAt = now();
        inFlight = false;
      });
  };

  const isReady = (current) =>
    lastError === null &&
    lastSuccessAt !== null &&
    current - lastSuccessAt < ttlMs + graceMs;

  function githubReady() {
    const current = now();
    refreshIfDue(current);
    return isReady(current);
  }

  githubReady.status = () => {
    const current = now();
    refreshIfDue(current);
    const ready = isReady(current);
    const state = ready
      ? "ready"
      : lastError !== null
        ? "failed"
        : lastSuccessAt !== null
          ? "stale"
          : "checking";
    return {
      state,
      checking: inFlight,
      ...(lastResultAt !== null
        ? {
            lastResultAgeSeconds: Math.max(
              0,
              Math.floor((current - lastResultAt) / 1000),
            ),
          }
        : {}),
      ...(lastError !== null ? { error: lastError } : {}),
    };
  };

  return githubReady;
}
