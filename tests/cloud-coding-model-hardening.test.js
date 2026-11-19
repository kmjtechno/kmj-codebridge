import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";
import {
  cloudCodingReceipt,
  normalizeModelReceipt,
} from "../src/model-attribution.js";

const receipt = (chain = "auto:code") => ({
  provider: "freellmapi-loopback",
  chain,
  response: "diff --git a/src/app.js b/src/app.js",
  hitTokenLimit: false,
  zeroCostRouteAdmissionVerified: true,
  billingVerified: false,
  paidInference: null,
  actualUpstreamModel: null,
  cloudFallback: null,
  outputIsUntrusted: true,
});

test("cloud catalog rejects coercion, deduplicates and bounds verifier calls to 32", async () => {
  let coerced = 0;
  const checked = [];
  const unsafe = {
    toString() {
      coerced++;
      throw new Error("COERCION");
    },
  };
  const names = Array.from({ length: 40 }, (_, i) => `auto:route${i}`);
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () => ({
        available: true,
        approvedFreeChains: [unsafe, null, 123, ...names, names[0], names[1]],
      }),
      checkZeroCostChain: async ({ chain }) => {
        checked.push(chain);
        return { admitted: true, chain };
      },
    }),
  });
  const status = await model.status();
  assert.equal(coerced, 0);
  assert.deepEqual(checked, names.slice(0, 32));
  assert.deepEqual(status.models, names.slice(0, 32));
  assert.equal(status.available, true);
});

test("cloud status discards earlier admissions when a later verifier revokes consent and throws", async () => {
  let consent = true;
  let checked = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({
      status: async () => ({
        available: true,
        approvedFreeChains: ["auto:first", "auto:second"],
      }),
      checkZeroCostChain: async ({ chain }) => {
        checked++;
        if (chain === "auto:second") {
          consent = false;
          throw new Error("VERIFIER_FAILED_AFTER_REVOCATION");
        }
        return { admitted: true, chain };
      },
    }),
  });
  assert.deepEqual(await model.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
  assert.equal(checked, 2);
});

test("cloud status fails closed on discovery errors without invoking attestation or generation", async () => {
  let verified = 0;
  let generated = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () => {
        throw new Error("DISCOVERY_OFFLINE");
      },
      checkZeroCostChain: async () => {
        verified++;
        return { admitted: true, chain: "auto:code" };
      },
      generate: async () => {
        generated++;
        return receipt();
      },
    }),
  });
  assert.deepEqual(await model.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
  assert.equal(verified, 0);
  assert.equal(generated, 0);
});

test("cloud discovery fails closed when owner consent or client discovery throws", async () => {
  let created = 0;
  const consentFailure = createVerifiedFreeCloudCodingModel({
    authorized: () => {
      throw new Error("CONSENT_BACKEND_OFFLINE");
    },
    createClient: () => {
      created++;
      throw new Error("CLIENT_MUST_NOT_START");
    },
  });
  assert.deepEqual(await consentFailure.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
  assert.equal(created, 0);

  const discoveryFailure = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () => {
        throw new Error("DISCOVERY_UNAVAILABLE");
      },
    }),
  });
  assert.deepEqual(await discoveryFailure.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
});

test("cloud discovery discards admitted routes if consent check fails after verification", async () => {
  let checks = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => {
      checks++;
      if (checks >= 4) throw new Error("CONSENT_BACKEND_OFFLINE");
      return true;
    },
    createClient: () => ({
      status: async () => ({
        available: true,
        approvedFreeChains: ["auto:code"],
      }),
      checkZeroCostChain: async ({ chain }) => ({ admitted: true, chain }),
    }),
  });
  assert.deepEqual(await model.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
});
