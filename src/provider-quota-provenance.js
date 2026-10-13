// Transport-independent, zero-dependency provider quota provenance.
// Consumers MUST source observations from an authenticated provider transport.
// Rate limits and per-key spending caps are NOT an entitlement to free inference.

const MAX_HEADER_CHARS = 120;
const MAX_RESET_MS = 31 * 24 * 60 * 60 * 1000;
const PROVIDERS = new Set([
  "groq",
  "anthropic",
  "openrouter",
  "openai-compatible",
  "custom",
]);

function header(headers, key) {
  let value = null;
  if (headers && typeof headers.get === "function") {
    value = headers.get(key);
  } else if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    const match = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === key,
    );
    value = match?.[1] ?? null;
  }
  if (Array.isArray(value)) value = value[0] ?? null;
  return typeof value === "string" && value.length <= MAX_HEADER_CHARS
    ? value.trim()
    : null;
}

function remaining(headers, key) {
  const text = header(headers, key);
  if (text === null || !/^\d{1,15}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function asCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseDeadline(value, nowMs) {
  if (typeof value !== "string" || value.length > MAX_HEADER_CHARS)
    return null;
  // Groq/OpenAI-compatible relative windows (1h2m3.5s, 7.66s).
  const relative = /^(?:(\d{1,7})h)?(?:(\d{1,7})m)?(?:(\d{1,7}(?:\.\d{1,3})?)s)?$/.exec(
    value,
  );
  if (relative && relative[0].length > 0 && relative.slice(1).some(Boolean)) {
    const ms =
      Number(relative[1] ?? 0) * 3600000 +
      Number(relative[2] ?? 0) * 60000 +
      Number(relative[3] ?? 0) * 1000;
    return ms <= MAX_RESET_MS && ms >= 0
      ? nowMs + Math.max(1000, Math.ceil(ms))
      : null;
  }
  // Anthropic RFC3339 timestamps. Require an explicit timezone.
  if (
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      value,
    )
  ) {
    const at = Date.parse(value);
    return Number.isFinite(at) && at > nowMs && at - nowMs <= MAX_RESET_MS
      ? at
      : null;
  }
  return null;
}

function deadline(headers, key, nowMs) {
  return parseDeadline(header(headers, key), nowMs);
}

function retryAfter(headers, nowMs) {
  const value = header(headers, "retry-after");
  if (value === null) return null;
  if (/^\d{1,7}(?:\.\d{1,3})?$/.test(value)) {
    const ms = Math.ceil(Number(value) * 1000);
    return Math.min(MAX_RESET_MS, Math.max(1000, ms));
  }
  const at = parseDeadline(value, nowMs);
  return at === null ? null : at - nowMs;
}

function credit(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function readOpenRouterKey(body) {
  // GET /api/v1/key describes a *spending cap*; it does not verify
  // free-model eligibility, balance, or zero-cost inference.
  const data = body?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const daily = data.free_model_daily_requests;
  const freeDaily =
    daily &&
    typeof daily === "object" &&
    !Array.isArray(daily) &&
    asCount(daily.remaining) !== null &&
    asCount(daily.limit) !== null &&
    asCount(daily.used) !== null &&
    daily.remaining <= daily.limit
      ? {
          remaining: daily.remaining,
          limit: daily.limit,
          used: daily.used,
        }
      : null;
  return {
    freeDailyRequests: freeDaily,
    keySpendCapRemaining: credit(data.limit_remaining),
    isFreeTierAccount:
      typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
  };
}

export function observeProviderQuota({
  provider,
  headers = null,
  source = "response",
  body = null,
  statusCode = null,
  observedAt = Date.now(),
}) {
  if (
    !PROVIDERS.has(provider) ||
    !["response", "openrouter-key"].includes(source) ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    (statusCode !== null &&
      (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) ||
    (source === "openrouter-key" && provider !== "openrouter")
  )
    throw new Error("INVALID_QUOTA_OBSERVATION");

  const anth = provider === "anthropic";
  const requestKey = anth
    ? "anthropic-ratelimit-requests-remaining"
    : "x-ratelimit-remaining-requests";
  const totalKey = anth
    ? "anthropic-ratelimit-tokens-remaining"
    : "x-ratelimit-remaining-tokens";
  const requestResetKey = anth
    ? "anthropic-ratelimit-requests-reset"
    : "x-ratelimit-reset-requests";
  const tokenResetKey = anth
    ? "anthropic-ratelimit-tokens-reset"
    : "x-ratelimit-reset-tokens";
  const requestsRemaining =
    remaining(headers, requestKey) ??
    (!anth ? remaining(headers, "x-ratelimit-remaining") : null);
  const tokensRemaining = remaining(headers, totalKey);
  const inputTokensRemaining = anth
    ? remaining(headers, "anthropic-ratelimit-input-tokens-remaining")
    : null;
  const outputTokensRemaining = anth
    ? remaining(headers, "anthropic-ratelimit-output-tokens-remaining")
    : null;
  const rateEvidence =
    requestsRemaining !== null ||
    tokensRemaining !== null ||
    inputTokensRemaining !== null ||
    outputTokensRemaining !== null;
  const key = source === "openrouter-key" ? readOpenRouterKey(body) : null;
  return {
    provider,
    observedAt,
    rateLimit: {
      provenance: rateEvidence ? "verified" : "unknown",
      requestsRemaining,
      tokensRemaining,
      inputTokensRemaining,
      outputTokensRemaining,
      requestsResetAt: deadline(headers, requestResetKey, observedAt),
      tokensResetAt: deadline(headers, tokenResetKey, observedAt),
      inputTokensResetAt: anth
        ? deadline(
            headers,
            "anthropic-ratelimit-input-tokens-reset",
            observedAt,
          )
        : null,
      outputTokensResetAt: anth
        ? deadline(
            headers,
            "anthropic-ratelimit-output-tokens-reset",
            observedAt,
          )
        : null,
      retryAfterMs:
        statusCode === 429 ? retryAfter(headers, observedAt) : null,
    },
    // Key spend-cap and API request/tokens MUST NOT be displayed as
    // remaining free credits. Free-model allowance is a separate quantity.
    freeDailyRequests: key?.freeDailyRequests ?? null,
    keySpendCapRemaining: key?.keySpendCapRemaining ?? null,
    isFreeTierAccount: key?.isFreeTierAccount ?? null,
    freeCreditsRemaining: null,
    freeCreditsProvenance: "unknown",
  };
}

// Pure routing *pressure signal*, NOT billing authorization. The caller
// must separately enforce model-level verified free pricing and user consent.
export function quotaPressure(
  observation,
  { inputTokens, maxOutputTokens, requestHeadroom = 1, tokenHeadroom = 0 },
) {
  if (
    asCount(inputTokens) === null ||
    asCount(maxOutputTokens) === null ||
    maxOutputTokens === 0 ||
    asCount(requestHeadroom) === null ||
    asCount(tokenHeadroom) === null
  )
    throw new Error("INVALID_QUOTA_TASK");
  const needed = inputTokens + maxOutputTokens + tokenHeadroom;
  if (!Number.isSafeInteger(needed)) throw new Error("INVALID_QUOTA_TASK");
  const quota = observation?.rateLimit;
  if (!quota || !["verified", "unknown"].includes(quota.provenance))
    throw new Error("INVALID_QUOTA_OBSERVATION");
  const checks = [
    ["REQUEST_HEADROOM_LOW", quota.requestsRemaining, requestHeadroom],
    ["TOTAL_TOKEN_HEADROOM_LOW", quota.tokensRemaining, needed],
    [
      "INPUT_TOKEN_HEADROOM_LOW",
      quota.inputTokensRemaining,
      inputTokens + tokenHeadroom,
    ],
    [
      "OUTPUT_TOKEN_HEADROOM_LOW",
      quota.outputTokensRemaining,
      maxOutputTokens + tokenHeadroom,
    ],
    [
      "FREE_DAILY_REQUESTS_LOW",
      observation.freeDailyRequests?.remaining ?? null,
      requestHeadroom,
    ],
  ];
  for (const [reason, remainingValue, threshold] of checks) {
    if (remainingValue !== null && remainingValue < threshold)
      return {
        switchSuggested: true,
        reason,
        evidence: "verified",
      };
  }
  if (quota.provenance === "unknown" && !observation.freeDailyRequests)
    return {
      switchSuggested: false,
      reason: "QUOTA_UNKNOWN",
      evidence: "unknown",
    };
  return {
    switchSuggested: false,
    reason: "NO_VERIFIED_LIMIT_PRESSURE",
    evidence: "verified",
  };
}
