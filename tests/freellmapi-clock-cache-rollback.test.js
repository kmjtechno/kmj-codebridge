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
  requestsRemaining: 2,
  observedAtEpochMs,
  expiresAtEpochMs: observedAtEpochMs + 30000,
});

test("clock rollback invalidates discovered chains before another prompt", async () => {
  let now = 1000000;
  let discoveries = 0;
  const posted = [];
  const client = createFreeLlmApiClient({
    apiKey: "test-key-00000001",
    approvedFreeChains: ["auto:code"],
    now: () => now,
    verifyZeroCostChain: proof,
    request: async ({ path, body }) => {
      if (path === "/v1/models") {
        discoveries++;
        return { data: discoveries === 1 ? [{ id: "auto:code" }] : [] };
      }
      posted.push(body);
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
    },
  });
  const args = {
    task: "code",
    prompt: "synthetic private sentinel",
    localProcessingApproved: true,
    upstreamCloudApproved: true,
  };
  await client.generateRouted(args);
  assert.equal(posted.length, 1);
  now -= 1000;
  await assert.rejects(client.generateRouted(args), {
    message: "FREELLMAPI_NO_APPROVED_CHAIN",
  });
  assert.equal(discoveries, 2);
  assert.equal(posted.length, 1);
});

test("invalid routed clocks reject before catalog discovery or cloud POST", async () => {
  for (const invalid of [NaN, Infinity, -Infinity, 1.5]) {
    let calls = 0;
    const client = createFreeLlmApiClient({
      apiKey: "test-key-00000001",
      approvedFreeChains: ["auto:code"],
      now: () => invalid,
      verifyZeroCostChain: proof,
      request: async () => { calls++; return { data: [{ id: "auto:code" }] }; },
    });
    await assert.rejects(client.generateRouted({
      task: "code",
      prompt: "synthetic private sentinel",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    }), { message: "FREELLMAPI_INVALID_CLOCK" });
    assert.equal(calls, 0);
  }
});
