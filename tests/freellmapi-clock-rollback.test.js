import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const consent = {
  task: "general",
  prompt: "synthetic test only",
  localProcessingApproved: true,
  upstreamCloudApproved: true,
};

test("clock rollback after model discovery fails closed before cloud POST", async () => {
  let ticks = [100000, 99000];
  let posts = 0;
  const client = createFreeLlmApiClient({
    apiKey: "clock-rollback-test-key",
    approvedFreeChains: ["auto:default"],
    now: () => ticks.shift() ?? 99000,
    request: async ({ method }) => {
      if (method === "POST") posts++;
      return { data: [{ id: "auto:default" }] };
    },
  });
  await assert.rejects(client.generateRouted(consent), {
    message: "FREELLMAPI_DEADLINE_EXCEEDED",
  });
  assert.equal(posts, 0);
});

test("clock rollback invalidates discovered chain cache", async () => {
  let clock = 100000;
  let discoveries = 0;
  const client = createFreeLlmApiClient({
    apiKey: "clock-rollback-test-key",
    approvedFreeChains: ["auto:default"],
    now: () => clock,
    verifyZeroCostChain: async ({ chain, observedAtEpochMs }) => ({
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
    }),
    request: async ({ method }) => {
      if (method === "GET") {
        discoveries++;
        return { data: [{ id: "auto:default" }] };
      }
      return { choices: [{ message: { content: "synthetic" } }] };
    },
  });
  await client.generateRouted(consent);
  clock = 90000;
  await client.generateRouted(consent);
  assert.equal(discoveries, 2);
});
