import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

test("asynchronous zero-cost verification rejects a backward clock before cloud POST", async () => {
  let clock = 100000;
  let posts = 0;
  const client = createFreeLlmApiClient({
    apiKey: "synthetic-clock-admission-key",
    approvedFreeChains: ["auto:default"],
    now: () => clock,
    verifyZeroCostChain: async ({ chain, observedAtEpochMs }) => {
      clock = 90000;
      return {
        source: "authenticated_provider_billing_and_route_binding",
        chain,
        routeBindingVerified: true,
        accountNoChargeVerified: true,
        noPaidFallback: true,
        inputPriceUsdPerToken: 0,
        outputPriceUsdPerToken: 0,
        requestsRemaining: 1,
        observedAtEpochMs,
        expiresAtEpochMs: observedAtEpochMs + 1000,
      };
    },
    request: async ({ method }) => {
      if (method === "POST") posts++;
      return { choices: [{ message: { content: "synthetic" } }] };
    },
  });
  await assert.rejects(
    client.generate({
      chain: "auto:default",
      prompt: "synthetic test only",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    }),
    { message: "FREELLMAPI_ZERO_COST_NOT_ATTESTED" },
  );
  assert.equal(posts, 0);
});
