import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const chain = "auto:default";
const proof = (time) => ({
  source: "authenticated_provider_billing_and_route_binding",
  chain,
  routeBindingVerified: true,
  accountNoChargeVerified: true,
  noPaidFallback: true,
  inputPriceUsdPerToken: 0,
  outputPriceUsdPerToken: 0,
  requestsRemaining: 1,
  observedAtEpochMs: time,
  expiresAtEpochMs: time + 10000,
});

for (const [name, times] of [
  ["NaN at admission", [Number.NaN]],
  ["infinite at admission", [Infinity]],
  ["fractional at admission", [1000.5]],
  ["rollback after asynchronous proof", [1000, 999]],
  ["invalid clock after asynchronous proof", [1000, Number.NaN]],
]) {
  test(`free admission rejects ${name} before any cloud POST`, async () => {
    let clockIndex = 0;
    let postCount = 0;
    const client = createFreeLlmApiClient({
      apiKey: "synthetic-test-key",
      approvedFreeChains: [chain],
      now: () => times[Math.min(clockIndex++, times.length - 1)],
      verifyZeroCostChain: async ({ observedAtEpochMs }) =>
        proof(observedAtEpochMs),
      request: async ({ method }) => {
        if (method === "POST") postCount++;
        return { data: [{ id: chain }] };
      },
    });
    await assert.rejects(
      client.generate({
        chain,
        prompt: "synthetic private code",
        localProcessingApproved: true,
        upstreamCloudApproved: true,
      }),
      { code: "FREELLMAPI_INVALID_CLOCK" },
    );
    assert.equal(postCount, 0);
  });
}
