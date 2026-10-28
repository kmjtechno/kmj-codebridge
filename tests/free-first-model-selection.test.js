import test from "node:test";
import assert from "node:assert/strict";
import { selectFreeFirstModel } from "../src/free-first-model-selection.js";
const now = 1793175000000;
const local = {
  source: "verified_local_health",
  available: true,
  model: "qwen2.5-coder:7b",
};
const cloud = {
  provider: "openrouter",
  source: "authenticated_provider_pricing",
  model: "vendor/coder:free",
  inputPriceUsdPerToken: 0,
  outputPriceUsdPerToken: 0,
  noPaidFallback: true,
  accountNoChargeVerified: true,
  observedAtEpochMs: now - 1000,
  requestsRemaining: 2,
};
test("verified local always wins over cloud and no fallback is allowed", () => {
  const v = selectFreeFirstModel({
    now,
    local,
    cloud,
    ownerCloudConsent: true,
  });
  assert.equal(v.route, "local");
  assert.equal(v.cloudRequestsAllowed, false);
  assert.equal(v.noPaidFallback, true);
});
test("missing consent or billing/pricing/quota attestation blocks free cloud", () => {
  const invalid = [
    { ownerCloudConsent: false },
    { cloud: { ...cloud, model: "vendor/coder" } },
    { cloud: { ...cloud, model: "vendor/coder:paid" } },
    { cloud: { ...cloud, source: "browser_input" } },
    { cloud: { ...cloud, accountNoChargeVerified: false } },
    { cloud: { ...cloud, noPaidFallback: false } },
    { cloud: { ...cloud, requestsRemaining: 0 } },
    { cloud: { ...cloud, inputPriceUsdPerToken: 0.0001 } },
    { cloud: { ...cloud, outputPriceUsdPerToken: 0.0001 } },
    { cloud: { ...cloud, observedAtEpochMs: now - 24 * 60 * 60 * 1000 } },
    { cloud: { ...cloud, observedAtEpochMs: now + 5001 } },
  ];
  for (const scenario of invalid) {
    const v = selectFreeFirstModel({
      now,
      ownerCloudConsent: true,
      cloud,
      ...scenario,
    });
    assert.equal(v.route, "blocked");
    assert.equal(v.cloudRequestsAllowed, false);
  }
});
test("explicit verified free model and no-charge account may be selected as a plan", () => {
  const v = selectFreeFirstModel({ now, ownerCloudConsent: true, cloud });
  assert.equal(v.route, "free-cloud");
  assert.equal(v.provider, "openrouter");
  assert.equal(v.model, "vendor/coder:free");
  assert.equal(v.noPaidFallback, true);
});
test("invalid local input or clock cannot silently enable cloud", () => {
  assert.throws(
    () => selectFreeFirstModel({ now: -1 }),
    /MODEL_ROUTE_INVALID_CLOCK/,
  );
  const v = selectFreeFirstModel({
    now,
    local: { ...local, model: "../../secret" },
    cloud,
  });
  assert.equal(v.route, "blocked");
});
