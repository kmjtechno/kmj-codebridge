import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

test("cloud result getter revoking consent cannot release a generated patch", async () => {
  let consent = true;
  let calls = 0;
  const response = {
    provider: "freellmapi-loopback",
    chain: "auto:code",
    zeroCostRouteAdmissionVerified: true,
    billingVerified: false,
    paidInference: null,
    actualUpstreamModel: null,
    cloudFallback: null,
    outputIsUntrusted: true,
    get response() {
      calls++;
      consent = false;
      return "diff --git a/a b/a";
    },
  };
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({ generate: async () => response }),
  });
  await assert.rejects(
    model.generate({ model: "auto:code", prompt: "OFFLINE_ONLY" }),
    /CLOUD_CODING_NOT_AUTHORIZED/,
  );
  assert.ok(calls > 0);
});
