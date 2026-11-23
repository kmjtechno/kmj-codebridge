import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

test("cloud discovery denies consent revoked by chain-array filter getter", async () => {
  let consent = true;
  let verifierCalls = 0;
  const chains = new Proxy(["auto:first"], {
    get(target, key, receiver) {
      if (key === "filter") consent = false;
      return Reflect.get(target, key, receiver);
    },
  });
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({
      status: async () => ({ available: true, approvedFreeChains: chains }),
      checkZeroCostChain: async () => {
        verifierCalls++;
        return { admitted: true, chain: "auto:first" };
      },
    }),
  });
  assert.deepEqual(await model.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
  assert.equal(verifierCalls, 0);
});

test("cloud discovery denies a proxy that throws during chain filtering", async () => {
  let verifierCalls = 0;
  const chains = new Proxy(["auto:first"], {
    get(target, key, receiver) {
      if (key === "filter") throw new Error("hostile filter getter");
      return Reflect.get(target, key, receiver);
    },
  });
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () => ({ available: true, approvedFreeChains: chains }),
      checkZeroCostChain: async () => {
        verifierCalls++;
        return { admitted: true, chain: "auto:first" };
      },
    }),
  });
  assert.deepEqual(await model.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
  assert.equal(verifierCalls, 0);
});
