import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

for (const [label, start, seconds] of [
  ["positive overflow", Number.MAX_SAFE_INTEGER - 1000, 5],
  ["negative safe boundary", Number.MIN_SAFE_INTEGER, 5],
]) {
  test(`routed deadline rejects unsafe clock arithmetic: ${label}`, async () => {
    const methods = [];
    const client = createFreeLlmApiClient({
      apiKey: "synthetic-key-not-real",
      approvedFreeChains: ["auto:code"],
      now: () => start,
      request: async ({ method }) => {
        methods.push(method);
        return { data: [{ id: "auto:code" }] };
      },
    });
    if (label === "positive overflow") {
      await assert.rejects(
        client.generateRouted({
          task: "code",
          prompt: "synthetic only",
          timeoutSeconds: seconds,
          localProcessingApproved: true,
          upstreamCloudApproved: true,
        }),
        { code: "FREELLMAPI_INVALID_CLOCK" },
      );
      assert.deepEqual(methods, [], "must reject before GET or POST");
    } else {
      // MIN_SAFE_INTEGER is safe; adding five seconds remains safe.
      await assert.rejects(
        client.generateRouted({
          task: "code",
          prompt: "synthetic only",
          timeoutSeconds: seconds,
          localProcessingApproved: true,
          upstreamCloudApproved: true,
        }),
        { code: "FREELLMAPI_ZERO_COST_NOT_ATTESTED" },
      );
      assert.deepEqual(methods, ["GET"], "safe boundary may discover, never POST");
    }
  });
}
