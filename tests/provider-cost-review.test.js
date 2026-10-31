import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewProviderCosts } from "../src/provider-cost-review.js";

// Synthetic numbers test arithmetic; they are not live provider prices.
const nowMs = 1793030400000;
const settings = {
  modelSpec: "veo-fast|8s|1080p|audio-on",
  billingUnit: "usd-per-video-job",
  referenceProvider: "direct",
  nowMs,
};
const quote = (provider, priceMicrosUsd, overrides = {}) => ({
  provider,
  priceMicrosUsd,
  modelSpec: settings.modelSpec,
  billingUnit: settings.billingUnit,
  observedAtMs: nowMs - 60_000,
  ...overrides,
});

test("compares exact spec/unit and labels caller-supplied pricing", () => {
  const result = reviewProviderCosts({
    ...settings,
    quotes: [quote("direct", 6000000), quote("alternative", 400000)],
  });
  assert.equal(result.comparisonStatus, "COMPARABLE_QUOTES");
  assert.equal(result.cheapest.provider, "alternative");
  assert.equal(result.illustrativeSavingsPct, 93.33);
  assert.equal(result.provenance, "CALLER_SUPPLIED_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(result.billableExecutionAuthorized, false);
  assert.equal(result.providerRequestsMade, 0);
});

test("does not compare unlike variant, billing units or stale prices", () => {
  const result = reviewProviderCosts({
    ...settings,
    quotes: [
      quote("direct", 6000000),
      quote("different", 10000, { modelSpec: "veo-fast|4s|480p|audio-off" }),
      quote("unit", 20000, { billingUnit: "usd-per-image-job" }),
      quote("old", 5000, { observedAtMs: nowMs - 24 * 60 * 60 * 1000 }),
      quote("future", 0, { observedAtMs: nowMs + 1 }),
    ],
  });
  assert.equal(result.comparisonStatus, "INSUFFICIENT_QUOTES");
  assert.equal(result.illustrativeSavingsPct, null);
  assert.deepEqual(result.excluded, {
    differentSpec: 1,
    differentUnit: 1,
    staleOrFuture: 2,
  });
});

test("no fake savings when reference is missing or free", () => {
  const missing = reviewProviderCosts({
    ...settings,
    quotes: [quote("other", 100), quote("third", 110)],
  });
  assert.equal(missing.illustrativeSavingsPct, null);
  assert.equal(missing.comparisonStatus, "INSUFFICIENT_QUOTES");
  const free = reviewProviderCosts({
    ...settings,
    quotes: [quote("direct", 0), quote("third", 500)],
  });
  assert.equal(free.illustrativeSavingsPct, null);
});

test("rejects malformed quotes and duplicate providers", () => {
  for (const bad of [
    quote("bad space", 12),
    quote("vendor", -1),
    quote("vendor", 1.5),
    quote("vendor", 0, { observedAtMs: NaN }),
  ]) {
    assert.throws(
      () => reviewProviderCosts({ ...settings, quotes: [bad] }),
      /INVALID_PROVIDER_COST_QUOTE/,
    );
  }
  assert.throws(
    () =>
      reviewProviderCosts({
        ...settings,
        quotes: [quote("same", 1), quote("same", 2)],
      }),
    /INVALID_PROVIDER_COST_QUOTE/,
  );
});

test("never authorizes inference for any observed price", () => {
  const result = reviewProviderCosts({
    ...settings,
    quotes: [quote("direct", 100), quote("reseller", 0)],
  });
  assert.equal(result.billableExecutionAuthorized, false);
  assert.equal(result.providerRequestsMade, 0);
});
