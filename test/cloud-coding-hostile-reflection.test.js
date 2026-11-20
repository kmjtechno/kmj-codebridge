import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

const unavailable = { available: false, activeRequest: false, models: [] };

test("cloud discovery rejects a proxy that throws on Array.isArray", async () => {
  let verified = 0;
  const chains = new Proxy(["auto:first"], {
    getPrototypeOf() {
      throw new Error("hostile prototype");
    },
  });
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () => ({ available: true, approvedFreeChains: chains }),
      checkZeroCostChain: async () => {
        verified++;
        return { admitted: true, chain: "auto:first" };
      },
    }),
  });
  // A proxy with hostile reflective traps must not escape status().
  assert.deepEqual(await model.status(), unavailable);
  assert.equal(verified, 0);
});

test("cloud discovery rejects a throwing status proxy without verifier calls", async () => {
  let verified = 0;
  const status = new Proxy({}, {
    get() {
      throw new Error("hostile status");
    },
  });
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () => status,
      checkZeroCostChain: async () => {
        verified++;
        return { admitted: true, chain: "auto:first" };
      },
    }),
  });
  assert.deepEqual(await model.status(), unavailable);
  assert.equal(verified, 0);
});
