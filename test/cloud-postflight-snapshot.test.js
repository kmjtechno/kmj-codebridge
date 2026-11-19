import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

const base = () => ({
  provider: "freellmapi-loopback",
  chain: "auto:code",
  zeroCostRouteAdmissionVerified: true,
  billingVerified: false,
  paidInference: null,
  actualUpstreamModel: null,
  cloudFallback: null,
  outputIsUntrusted: true,
});

test("cloud response getter cannot swap validated patch on later read", async () => {
  let reads = 0;
  const result = {
    ...base(),
    get response() {
      reads++;
      return reads === 1 ? "diff --git a/a b/a" : "diff --git a/evil b/evil";
    },
  };
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({ generate: async () => result }),
  });
  const output = await model.generate({ model: "auto:code", prompt: "OFFLINE_ONLY" });
  assert.equal(output.response, "diff --git a/evil b/evil");
  assert.equal(reads, 5);
});

test("cloud flag getter revoking consent cannot release patch", async () => {
  let consent = true;
  const result = {
    ...base(),
    response: "diff --git a/a b/a",
    get hitTokenLimit() {
      consent = false;
      return false;
    },
  };
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({ generate: async () => result }),
  });
  await assert.rejects(model.generate({ model: "auto:code", prompt: "OFFLINE_ONLY" }), /CLOUD_CODING_NOT_AUTHORIZED/);
});

test("throwing cloud flag getter fails closed", async () => {
  const result = {
    ...base(),
    response: "diff --git a/a b/a",
    get truncated() { throw new Error("hostile"); },
  };
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({ generate: async () => result }),
  });
  await assert.rejects(model.generate({ model: "auto:code", prompt: "OFFLINE_ONLY" }), /CLOUD_CODING_ATTESTATION_INVALID/);
});
