import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

// Offline-only regression: a completed transport response is not permission
// to apply a patch after consent is withdrawn or its provider starts throwing.
const result = () => ({
  provider: "freellmapi-loopback",
  chain: "auto:code",
  response: "diff --git a/a b/a",
  zeroCostRouteAdmissionVerified: true,
  billingVerified: false,
  paidInference: null,
  actualUpstreamModel: null,
  cloudFallback: null,
  outputIsUntrusted: true,
});

for (const mode of ["revoked", "throwing"]) {
  test(`cloud generation rejects postflight consent ${mode} without returning patch`, async () => {
    let checks = 0;
    let transportCalls = 0;
    const model = createVerifiedFreeCloudCodingModel({
      authorized: () => {
        checks++;
        if (checks === 1) return true;
        if (mode === "throwing") throw new Error("CONSENT_BACKEND_UNAVAILABLE");
        return false;
      },
      createClient: () => ({
        generate: async () => {
          transportCalls++;
          return result();
        },
      }),
    });
    await assert.rejects(
      model.generate({ model: "auto:code", prompt: "OFFLINE_TEST_ONLY" }),
      /CLOUD_CODING_NOT_AUTHORIZED/,
    );
    assert.equal(transportCalls, 1);
    assert.equal(checks, 2);
  });
}
