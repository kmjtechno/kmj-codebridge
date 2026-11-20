import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

const unavailable = { available: false, activeRequest: false, models: [] };

test("cloud discovery denies throwing availability getter without verifying chains", async () => {
  let verified = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () =>
        Object.defineProperty({}, "available", {
          get() {
            throw new Error("hostile getter");
          },
        }),
      checkZeroCostChain: async () => {
        verified++;
        throw new Error("must not verify");
      },
    }),
  });
  assert.deepEqual(await model.status(), unavailable);
  assert.equal(verified, 0);
});

test("cloud discovery denies hostile approved chain array proxy", async () => {
  let verified = 0;
  const chains = new Proxy(["auto:code"], {
    get(target, key, receiver) {
      if (key === "slice") throw new Error("hostile array");
      return Reflect.get(target, key, receiver);
    },
  });
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () => ({ available: true, approvedFreeChains: chains }),
      checkZeroCostChain: async () => {
        verified++;
        throw new Error("must not verify");
      },
    }),
  });
  assert.deepEqual(await model.status(), unavailable);
  assert.equal(verified, 0);
});

test("cloud discovery revocation from getter prevents any verifier invocation", async () => {
  let consent = true;
  let verified = 0;
  const status = { available: true };
  Object.defineProperty(status, "approvedFreeChains", {
    get() {
      consent = false;
      return ["auto:code"];
    },
  });
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({
      status: async () => status,
      checkZeroCostChain: async () => {
        verified++;
        throw new Error("must not verify");
      },
    }),
  });
  assert.deepEqual(await model.status(), unavailable);
  assert.equal(verified, 0);
});

test("cloud discovery stops after a verifier revokes consent and throws", async () => {
  let consent = true;
  const checked = [];
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({
      status: async () => ({
        available: true,
        approvedFreeChains: ["auto:first", "auto:second"],
      }),
      checkZeroCostChain: async ({ chain }) => {
        checked.push(chain);
        consent = false;
        throw new Error("verification failed after consent revocation");
      },
    }),
  });
  assert.deepEqual(await model.status(), unavailable);
  assert.deepEqual(checked, ["auto:first"]);
});
