// Fail-closed Cloud LLM choice for a ZERO additional-cost installation.
// This planner never makes a network request, enables billing or stores keys.
const MODELS = /^[a-z0-9][a-z0-9._-]{0,79}\\/[a-z0-9][a-z0-9._-]{0,79}:free$/;
const FRESH_PRICING_MS = 24 * 60 * 60 * 1000;
export function selectFreeFirstModel({
  local = null,
  cloud = null,
  ownerCloudConsent = false,
  now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("MODEL_ROUTE_INVALID_CLOCK");
  if (local?.source === "verified_local_health" &&
      local.available === true &&
      typeof local.model === "string" &&
      /^[A-Za-z0-9._:/-]{1,96}$/.test(local.model)) {
    return {
      route: "local",
      model: local.model,
      provider: "local-owner-host",
      noPaidFallback: true,
      cloudRequestsAllowed: false,
      evidence: "verified_local_health",
    };
  }
  const good = ownerCloudConsent === true &&
    cloud?.provider === "openrouter" &&
    cloud?.source === "authenticated_provider_pricing" &&
    typeof cloud.model === "string" && MODELS.test(cloud.model) &&
    cloud?.inputPriceUsdPerToken === 0 &&
    cloud?.outputPriceUsdPerToken === 0 &&
    cloud?.noPaidFallback === true &&
    cloud?.accountNoChargeVerified === true &&
    Number.isSafeInteger(cloud?.observedAtEpochMs) &&
    cloud.observedAtEpochMs <= now + 5000 &&
    cloud.observedAtEpochMs > now - FRESH_PRICING_MS &&
    Number.isSafeInteger(cloud?.requestsRemaining) &&
    cloud.requestsRemaining >= 1;
  if (!good) return {
    route: "blocked",
    model: null,
    provider: null,
    noPaidFallback: true,
    cloudRequestsAllowed: false,
    evidence: "FREE_ONLY_INFERENCE_NOT_ATTESTED",
  };
  return {
    route: "free-cloud",
    model: cloud.model,
    provider: "openrouter",
    noPaidFallback: true,
    cloudRequestsAllowed: true,
    evidence: "authenticated_provider_pricing",
  };
}
