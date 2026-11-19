import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

// Synthetic, offline-only admission regression. Never reaches a provider.
const key = "synthetic-test-key-0001";
const clock = 1_800_000_000_000;
const valid = (chain) => ({
  source: "authenticated_provider_billing_and_route_binding",
  chain,
  routeBindingVerified: true,
  accountNoChargeVerified: true,
  noPaidFallback: true,
  inputPriceUsdPerToken: 0,
  outputPriceUsdPerToken: 0,
  requestsRemaining: 1,
  observedAtEpochMs: clock,
  expiresAtEpochMs: clock + 30_000,
});

test("adversarial zero-cost proof values never transmit private source", async () => {
  const invalid = [
    ["non-finite input price", { inputPriceUsdPerToken: NaN }],
    ["non-finite output price", { outputPriceUsdPerToken: Infinity }],
    ["string price", { inputPriceUsdPerToken: "0" }],
    ["fractional quota", { requestsRemaining: 0.5 }],
    ["negative quota", { requestsRemaining: -1 }],
    ["future observation", { observedAtEpochMs: clock + 1 }],
    ["expired observation", { observedAtEpochMs: clock - 60_000 }],
    ["overlong expiry", { expiresAtEpochMs: clock + 60_001 }],
    ["missing route binding", { routeBindingVerified: undefined }],
    ["unverified fallback", { noPaidFallback: undefined }],
  ];
  for (const [name, patch] of invalid) {
    let calls = 0;
    const client = createFreeLlmApiClient({
      apiKey: key,
      now: () => clock,
      approvedFreeChains: ["auto:code"],
      verifyZeroCostChain: ({ chain }) => ({ ...valid(chain), ...patch }),
      request: async () => {
        calls++;
        throw new Error("UNEXPECTED_NETWORK");
      },
    });
    await assert.rejects(
      client.generate({
        chain: "auto:code",
        prompt: "PRIVATE_SOURCE_SENTINEL",
        localProcessingApproved: true,
        upstreamCloudApproved: true,
      }),
      { code: "FREELLMAPI_ZERO_COST_NOT_ATTESTED" },
      name,
    );
    assert.equal(calls, 0, name);
  }
});
