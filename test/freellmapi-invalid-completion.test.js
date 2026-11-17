import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const chain = "auto:default";
function makeClient(completion) {
  let posts = 0;
  const client = createFreeLlmApiClient({
    apiKey: "test-key-12345",
    approvedFreeChains: [chain],
    now: () => 100000,
    verifyZeroCostChain: async () => ({
      source: "authenticated_provider_billing_and_route_binding",
      chain,
      routeBindingVerified: true,
      accountNoChargeVerified: true,
      noPaidFallback: true,
      inputPriceUsdPerToken: 0,
      outputPriceUsdPerToken: 0,
      requestsRemaining: 1,
      observedAtEpochMs: 100000,
      expiresAtEpochMs: 110000,
    }),
    request: async ({ method }) => {
      if (method === "POST") {
        posts++;
        return completion;
      }
      return { data: [{ id: chain }] };
    },
  });
  return { client, get posts() { return posts; } };
}
const args = {
  chain,
  prompt: "Synthetic public fixture",
  localProcessingApproved: true,
  upstreamCloudApproved: true,
};
for (const [name, completion] of [
  ["missing choices", {}],
  ["null choices", { choices: null }],
  ["object choices", { choices: {} }],
  ["empty choices", { choices: [] }],
  ["null first choice", { choices: [null] }],
  ["missing message", { choices: [{ finish_reason: "stop" }] }],
  ["numeric content", { choices: [{ message: { content: 123 }, finish_reason: "stop" }] }],
  ["empty content", { choices: [{ message: { content: "" }, finish_reason: "stop" }] }],
  ["missing finish reason", { choices: [{ message: { content: "ok" } }] }],
]) {
  test("malformed completion fails closed: " + name, async () => {
    const ctx = makeClient(completion);
    await assert.rejects(ctx.client.generate(args), { code: "FREELLMAPI_BAD_COMPLETION" });
    assert.equal(ctx.posts, 1);
  });
}
test("valid completion remains accepted", async () => {
  const ctx = makeClient({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  const result = await ctx.client.generate(args);
  assert.equal(result.response, "ok");
  assert.equal(ctx.posts, 1);
});
