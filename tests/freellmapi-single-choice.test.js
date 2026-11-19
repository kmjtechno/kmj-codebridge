import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const chain = "auto:default";
const proof = (observedAtEpochMs) => ({
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
});
const completion = {
  message: { role: "assistant", content: "synthetic output" },
  finish_reason: "stop",
};

for (const [label, choices, accepted] of [
  ["single choice", [completion], true],
  ["empty choices", [], false],
  ["two valid choices", [completion, completion], false],
  ["valid plus malformed", [completion, null], false],
]) {
  test(`FreeLLMAPI ${label}: unambiguous completion required`, async () => {
    let posts = 0;
    const client = createFreeLlmApiClient({
      apiKey: "synthetic-test-key",
      approvedFreeChains: [chain],
      now: () => 100000,
      verifyZeroCostChain: async ({ observedAtEpochMs }) =>
        proof(observedAtEpochMs),
      request: async ({ method }) => {
        if (method === "POST") {
          posts += 1;
          return { choices };
        }
        return { data: [{ id: chain }] };
      },
    });
    const task = client.generate({
      chain,
      prompt: "synthetic prompt",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    });
    if (accepted) {
      assert.equal((await task).response, "synthetic output");
    } else {
      await assert.rejects(task, { code: "FREELLMAPI_BAD_COMPLETION" });
    }
    assert.equal(posts, 1);
  });
}
