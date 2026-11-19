import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const options = {
  apiKey: "test-key-not-real",
  approvedFreeChains: ["auto:code", "auto:coder"],
};

test("routed generation rejects clock rollback after catalog discovery before any POST", async () => {
  const calls = [];
  const ticks = [100000, 99999];
  const client = createFreeLlmApiClient({
    ...options,
    now: () => ticks.shift() ?? 99999,
    request: async ({ method }) => {
      calls.push(method);
      return { data: [{ id: "auto:code" }] };
    },
  });
  await assert.rejects(
    client.generateRouted({
      task: "code",
      prompt: "synthetic test only",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    }),
    { code: "FREELLMAPI_INVALID_CLOCK" },
  );
  assert.deepEqual(calls, ["GET"]);
});

test("routed generation rejects nonfinite clock after catalog discovery before POST", async () => {
  let calls = 0;
  const ticks = [100000, Number.NaN];
  const client = createFreeLlmApiClient({
    ...options,
    now: () => ticks.shift() ?? Number.NaN,
    request: async () => {
      calls++;
      return { data: [{ id: "auto:code" }] };
    },
  });
  await assert.rejects(
    client.generateRouted({
      task: "code",
      prompt: "synthetic test only",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    }),
    { code: "FREELLMAPI_INVALID_CLOCK" },
  );
  assert.equal(calls, 1);
});

test("quota fallback refuses second cloud POST after clock rollback", async () => {
  let posts = 0;
  const ticks = [100000, 100000, 100000, 100000, 99999];
  const client = createFreeLlmApiClient({
    ...options,
    now: () => ticks.shift() ?? 99999,
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
      expiresAtEpochMs: observedAtEpochMs + 10000,
    }),
    request: async ({ method }) => {
      if (method === "GET")
        return { data: [{ id: "auto:code" }, { id: "auto:coder" }] };
      posts++;
      throw Object.assign(new Error("FREELLMAPI_QUOTA_EXHAUSTED"), {
        code: "FREELLMAPI_QUOTA_EXHAUSTED",
      });
    },
  });
  await assert.rejects(
    client.generateRouted({
      task: "code",
      prompt: "synthetic test only",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    }),
    { code: "FREELLMAPI_INVALID_CLOCK" },
  );
  assert.equal(posts, 1);
});
