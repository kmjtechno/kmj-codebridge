import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const proof = ({ chain, observedAtEpochMs }) => ({
  source: "authenticated_provider_billing_and_route_binding",
  chain,
  routeBindingVerified: true,
  accountNoChargeVerified: true,
  noPaidFallback: true,
  inputPriceUsdPerToken: 0,
  outputPriceUsdPerToken: 0,
  requestsRemaining: 1,
  observedAtEpochMs,
  expiresAtEpochMs: observedAtEpochMs + 30000,
});

const consent = {
  chain: "auto:default",
  prompt: "PRIVATE_SOURCE_SENTINEL",
  localProcessingApproved: true,
  upstreamCloudApproved: true,
};

test("invalid clock fails before attestor or cloud POST", async () => {
  for (const invalid of [NaN, Infinity, -Infinity, 1.5]) {
    let attestorCalls = 0;
    let networkCalls = 0;
    const client = createFreeLlmApiClient({
      apiKey: "test-key-00000001",
      approvedFreeChains: ["auto:default"],
      now: () => invalid,
      verifyZeroCostChain: (args) => {
        attestorCalls++;
        return proof(args);
      },
      request: async () => {
        networkCalls++;
        throw new Error("unexpected network");
      },
    });
    await assert.rejects(client.generate(consent), {
      message: "FREELLMAPI_INVALID_CLOCK",
    });
    assert.equal(attestorCalls, 0);
    assert.equal(networkCalls, 0);
  }
});

test("clock rollback during async billing proof cannot authorize cloud POST", async () => {
  let clock = 1000000;
  let networkCalls = 0;
  const client = createFreeLlmApiClient({
    apiKey: "test-key-00000001",
    approvedFreeChains: ["auto:default"],
    now: () => clock,
    verifyZeroCostChain: async (args) => {
      clock -= 1000;
      return proof(args);
    },
    request: async () => {
      networkCalls++;
      throw new Error("unexpected cloud POST");
    },
  });
  await assert.rejects(client.generate(consent), {
    message: "FREELLMAPI_INVALID_CLOCK",
  });
  assert.equal(networkCalls, 0);
});
