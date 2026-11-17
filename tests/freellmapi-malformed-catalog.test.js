import assert from "node:assert/strict";
import { test } from "node:test";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

for (const data of [undefined, null, {}, "auto:default", 42]) {
  test(`malformed FreeLLMAPI model catalog fails closed: ${String(data)}`, async () => {
    let posts = 0;
    const client = createFreeLlmApiClient({
      apiKey: "test-key-not-secret",
      approvedFreeChains: ["auto:default"],
      request: async ({ method }) => {
        if (method === "POST") posts += 1;
        return data === undefined ? {} : { data };
      },
    });
    await assert.rejects(client.status(), { message: "FREELLMAPI_BAD_RESPONSE" });
    await assert.rejects(
      client.generateRouted({
        task: "general",
        prompt: "synthetic nonprivate prompt",
        localProcessingApproved: true,
        upstreamCloudApproved: true,
      }),
      { message: "FREELLMAPI_BAD_RESPONSE" },
    );
    assert.equal(posts, 0);
  });
}
