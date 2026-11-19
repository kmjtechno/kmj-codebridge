import assert from "node:assert/strict";
import test from "node:test";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

for (const ids of [
  ["auto:code", "auto:code"],
  ["auto:code", "auto:default", "auto:code"],
  ["unrelated-model", "unrelated-model"],
]) {
  test(`duplicate catalog IDs fail closed: ${ids.join(",")}`, async () => {
    let posts = 0;
    const client = createFreeLlmApiClient({
      apiKey: "test-key-12345678",
      approvedFreeChains: ["auto:code", "auto:default"],
      verifyZeroCostChain: async () => {
        throw new Error("billing proof must not be reached");
      },
      request: async ({ method }) => {
        if (method === "POST") posts++;
        return { data: ids.map((id) => ({ id })) };
      },
    });
    await assert.rejects(client.status(), { code: "FREELLMAPI_BAD_RESPONSE" });
    await assert.rejects(
      client.generateRouted({
        task: "code",
        prompt: "private source",
        localProcessingApproved: true,
        upstreamCloudApproved: true,
      }),
      { code: "FREELLMAPI_BAD_RESPONSE" },
    );
    assert.equal(posts, 0);
  });
}

test("distinct catalog IDs remain discoverable", async () => {
  const client = createFreeLlmApiClient({
    apiKey: "test-key-12345678",
    request: async () => ({
      data: [{ id: "auto:code" }, { id: "auto:default" }],
    }),
  });
  assert.deepEqual((await client.status()).chains, ["auto:code", "auto:default"]);
});
