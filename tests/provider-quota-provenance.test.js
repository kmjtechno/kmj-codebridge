import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observeProviderQuota,
  quotaPressure,
} from "../src/provider-quota-provenance.js";

const NOW = Date.parse("2026-10-14T00:00:00Z");
const task = { inputTokens: 2500, maxOutputTokens: 512 };

test("Groq reports RPD/TPM verified separately, not remaining free credits", () => {
  const obs = observeProviderQuota({
    provider: "groq",
    observedAt: NOW,
    statusCode: 200,
    headers: {
      "X-RateLimit-Remaining-Requests": "42",
      "x-ratelimit-remaining-tokens": "3200",
      "x-ratelimit-reset-requests": "2m59.56s",
      "x-ratelimit-reset-tokens": "7.66s",
    },
  });
  assert.equal(obs.rateLimit.provenance, "verified");
  assert.equal(obs.rateLimit.requestsRemaining, 42);
  assert.equal(obs.rateLimit.tokensRemaining, 3200);
  assert.equal(obs.rateLimit.requestsResetAt, NOW + 179_560);
  assert.equal(obs.rateLimit.tokensResetAt, NOW + 7660);
  assert.equal(obs.freeCreditsRemaining, null);
  assert.equal(obs.freeCreditsProvenance, "unknown");
  assert.equal(quotaPressure(obs, task).switchSuggested, false);
});

test("Groq low TPM proactively suggests switching before the next request", () => {
  const obs = observeProviderQuota({
    provider: "groq",
    observedAt: NOW,
    headers: {
      "x-ratelimit-remaining-requests": "15",
      "x-ratelimit-remaining-tokens": "3000",
    },
  });
  assert.deepEqual(quotaPressure(obs, task), {
    switchSuggested: true,
    reason: "TOTAL_TOKEN_HEADROOM_LOW",
    evidence: "verified",
  });
});

test("Anthropic parses verified request, input/output and RFC3339 reset", () => {
  const reset = "2026-10-14T00:01:15Z";
  const obs = observeProviderQuota({
    provider: "anthropic",
    observedAt: NOW,
    headers: new Headers({
      "anthropic-ratelimit-requests-remaining": "2",
      "anthropic-ratelimit-input-tokens-remaining": "5000",
      "anthropic-ratelimit-output-tokens-remaining": "100",
      "anthropic-ratelimit-requests-reset": reset,
      "anthropic-ratelimit-output-tokens-reset": reset,
    }),
  });
  assert.equal(obs.rateLimit.requestsRemaining, 2);
  assert.equal(obs.rateLimit.tokensRemaining, null);
  assert.equal(obs.rateLimit.inputTokensRemaining, 5000);
  assert.equal(obs.rateLimit.outputTokensRemaining, 100);
  assert.equal(obs.rateLimit.requestsResetAt, NOW + 75_000);
  assert.equal(obs.rateLimit.outputTokensResetAt, NOW + 75_000);
  assert.deepEqual(quotaPressure(obs, task), {
    switchSuggested: true,
    reason: "OUTPUT_TOKEN_HEADROOM_LOW",
    evidence: "verified",
  });
  assert.equal(obs.freeCreditsRemaining, null);
});

test("OpenRouter key spend cap never authorizes inferred free daily requests", () => {
  const body = {
    data: {
      label: "SECRET-KEY-LABEL",
      is_free_tier: true,
      limit_remaining: 12.5,
      free_model_daily_requests: {
        used: 48,
        limit: 50,
        remaining: 2,
      },
    },
  };
  const obs = observeProviderQuota({
    provider: "openrouter",
    source: "openrouter-key",
    body,
    observedAt: NOW,
  });
  assert.equal(obs.keySpendCapRemaining, 12.5);
  assert.equal(obs.isFreeTierAccount, true);
  assert.equal(obs.freeDailyRequests, null);
  assert.equal(obs.freeCreditsRemaining, null);
  assert.equal(obs.rateLimit.provenance, "unknown");
  assert.equal(JSON.stringify(obs).includes("SECRET-KEY-LABEL"), false);
  assert.deepEqual(quotaPressure(obs, { ...task, requestHeadroom: 3 }), {
    switchSuggested: false,
    reason: "QUOTA_UNKNOWN",
    evidence: "unknown",
  });
});

test("absent OpenRouter key fields never imply unlimited or a free balance", () => {
  const obs = observeProviderQuota({
    provider: "openrouter",
    source: "openrouter-key",
    body: { data: { limit_remaining: null, is_free_tier: false } },
    observedAt: NOW,
  });
  assert.equal(obs.keySpendCapRemaining, null);
  assert.equal(obs.freeDailyRequests, null);
  assert.equal(obs.freeCreditsRemaining, null);
  assert.deepEqual(quotaPressure(obs, task), {
    switchSuggested: false,
    reason: "QUOTA_UNKNOWN",
    evidence: "unknown",
  });
});

test("malformed/negative/header-injection counts remain unknown", () => {
  const obs = observeProviderQuota({
    provider: "groq",
    observedAt: NOW,
    headers: {
      "x-ratelimit-remaining-requests": "-3",
      "x-ratelimit-remaining-tokens": "4\r\nSet-Cookie: stolen",
      "x-ratelimit-reset-requests": "999999999999h",
    },
  });
  assert.equal(obs.rateLimit.provenance, "unknown");
  assert.equal(obs.rateLimit.requestsRemaining, null);
  assert.equal(obs.rateLimit.tokensRemaining, null);
  assert.equal(obs.rateLimit.requestsResetAt, null);
});

test("headers as arrays and numeric Retry-After on 429 are bounded", () => {
  const obs = observeProviderQuota({
    provider: "custom",
    statusCode: 429,
    observedAt: NOW,
    headers: {
      "Retry-After": ["2.5"],
      "X-RATELIMIT-REMAINING": ["0"],
    },
  });
  assert.equal(obs.rateLimit.retryAfterMs, 2500);
  assert.equal(obs.rateLimit.requestsRemaining, 0);
  assert.equal(quotaPressure(obs, task).reason, "REQUEST_HEADROOM_LOW");
  assert.equal(
    observeProviderQuota({
      provider: "groq",
      statusCode: 200,
      observedAt: NOW,
      headers: { "retry-after": "10" },
    }).rateLimit.retryAfterMs,
    null,
  );
});

test("no API key or raw response data ever appears in quota output", () => {
  const obs = observeProviderQuota({
    provider: "openrouter",
    source: "openrouter-key",
    observedAt: NOW,
    body: {
      data: {
        api_key: "secret-user-value",
        label: "secret-label",
        is_free_tier: true,
        limit_remaining: 0,
      },
    },
    headers: { authorization: "Bearer secret-user-value" },
  });
  assert.equal(JSON.stringify(obs).includes("secret"), false);
  assert.equal(obs.keySpendCapRemaining, 0);
});

test("malformed OpenRouter daily allowance cannot be trusted", () => {
  const obs = observeProviderQuota({
    provider: "openrouter",
    source: "openrouter-key",
    observedAt: NOW,
    body: {
      data: {
        free_model_daily_requests: {
          used: 50,
          limit: 5,
          remaining: 10,
        },
      },
    },
  });
  assert.equal(obs.freeDailyRequests, null);
  assert.equal(obs.rateLimit.provenance, "unknown");
});

test("unknown or malformed quota does not claim a safe free inference", () => {
  const obs = observeProviderQuota({
    provider: "anthropic",
    observedAt: NOW,
    statusCode: 200,
    headers: {},
  });
  assert.deepEqual(quotaPressure(obs, task), {
    switchSuggested: false,
    reason: "QUOTA_UNKNOWN",
    evidence: "unknown",
  });
  assert.throws(
    () => quotaPressure(obs, { inputTokens: -1, maxOutputTokens: 5 }),
    /INVALID_QUOTA_TASK/,
  );
  assert.throws(
    () => observeProviderQuota({ provider: "no-such-provider" }),
    /INVALID_QUOTA_OBSERVATION/,
  );
  assert.throws(
    () =>
      observeProviderQuota({
        provider: "groq",
        source: "openrouter-key",
      }),
    /INVALID_QUOTA_OBSERVATION/,
  );
});
