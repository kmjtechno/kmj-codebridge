// Pure, source-only evaluation of OpenRouter evidence for the FreeLLMAPI
// zero-cost admission gate (see docs/OPENROUTER-FREE-EVIDENCE.md).
//
// It performs NO network I/O, reads no secrets and is imported by nothing yet.
// Trusted device code must fetch GET /api/v1/key (authenticated, owner key) and
// the chain's route-binding evidence, then pass the parsed JSON here. Every
// check fails closed: unknown, missing or ambiguous evidence is "not verified".
const MODEL_ID =
  /^[a-z0-9][a-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}:free$/;
const CHAIN = /^auto:[A-Za-z0-9._-]{1,48}$/;
export const PROOF_SOURCE = "authenticated_provider_billing_and_route_binding";
export const PROOF_TTL_MS = 30000;

const zero = (v) => typeof v === "number" && Number.isFinite(v) && v === 0;
const count = (v) => Number.isSafeInteger(v) && v >= 0;

// Account side: only provable zero spend counts. Any recorded credit or BYOK
// usage, a blocking budget, or an unreadable counter means "not verified".
export function evaluateAccountEvidence(keyResponse) {
  const d = keyResponse?.data;
  const reasons = [];
  if (!d || typeof d !== "object")
    return {
      ok: false,
      requestsRemaining: 0,
      reasons: ["KEY_RESPONSE_MISSING"],
    };
  for (const field of [
    "usage",
    "usage_daily",
    "usage_weekly",
    "usage_monthly",
    "byok_usage",
  ])
    if (!zero(d[field])) reasons.push(`SPEND_NOT_ZERO:${field}`);
  if (d.effective_budget != null) {
    const r = d.effective_budget.remaining_usd;
    if (typeof r !== "number" || !Number.isFinite(r) || r <= 0)
      reasons.push("BUDGET_BLOCKING");
  }
  if (
    d.limit_remaining != null &&
    !(typeof d.limit_remaining === "number" && d.limit_remaining > 0)
  )
    reasons.push("KEY_LIMIT_EXHAUSTED");
  const q = d.free_model_daily_requests;
  const remaining =
    q &&
    count(q.used) &&
    count(q.limit) &&
    count(q.remaining) &&
    q.remaining > 0 &&
    q.used + q.remaining <= q.limit
      ? q.remaining
      : 0;
  if (remaining === 0) reasons.push("FREE_QUOTA_UNKNOWN_OR_EXHAUSTED");
  return { ok: reasons.length === 0, requestsRemaining: remaining, reasons };
}

// Model side: exact vendor/model:free ID and published per-token prices of 0.
// OpenRouter publishes prices as decimal strings; anything else is rejected.
export function isVerifiedFreeModel(entry) {
  const p = entry?.pricing;
  if (typeof entry?.id !== "string" || !MODEL_ID.test(entry.id) || !p)
    return false;
  const free = (v) => typeof v === "string" && /^0(\.0+)?$/.test(v);
  return free(p.prompt) && free(p.completion);
}

// Combines account evidence with route-binding evidence that only trusted
// device code can supply (what the chain really routes to, and that no paid
// fallback exists). Returns a proof for verifyZeroCostChain, or null.
export function buildZeroCostProof({
  chain,
  observedAtEpochMs,
  keyResponse,
  routeBinding,
}) {
  if (typeof chain !== "string" || !CHAIN.test(chain)) return null;
  if (!Number.isSafeInteger(observedAtEpochMs)) return null;
  const account = evaluateAccountEvidence(keyResponse);
  if (!account.ok) return null;
  const b = routeBinding;
  if (
    !b ||
    b.chain !== chain ||
    b.verified !== true ||
    b.noPaidFallback !== true ||
    !Array.isArray(b.models) ||
    b.models.length === 0 ||
    b.models.length > 50 ||
    !b.models.every(isVerifiedFreeModel)
  )
    return null;
  return {
    source: PROOF_SOURCE,
    chain,
    routeBindingVerified: true,
    accountNoChargeVerified: true,
    noPaidFallback: true,
    inputPriceUsdPerToken: 0,
    outputPriceUsdPerToken: 0,
    requestsRemaining: account.requestsRemaining,
    observedAtEpochMs,
    expiresAtEpochMs: observedAtEpochMs + PROOF_TTL_MS,
  };
}
