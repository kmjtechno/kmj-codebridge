import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

const unavailable = { available: false, activeRequest: false, models: [] };

test("hostile discovery getters and array proxies fail closed without route admission", async () => {
  const hostile = [
    Object.defineProperty({}, "available", {
      get() {
        throw new Error("HOSTILE_AVAILABLE");
      },
    }),
    Object.defineProperty({ available: true }, "approvedFreeChains", {
      get() {
        throw new Error("HOSTILE_CHAINS");
      },
    }),
    {
      available: true,
      approvedFreeChains: new Proxy(["auto:code"], {
        get(target, property, receiver) {
          if (property === "slice") throw new Error("HOSTILE_SLICE");
          return Reflect.get(target, property, receiver);
        },
      }),
    },
  ];
  for (const response of hostile) {
    let verificationCalls = 0;
    const model = createVerifiedFreeCloudCodingModel({
      authorized: () => true,
      createClient: () => ({
        status: async () => response,
        checkZeroCostChain: async () => {
          verificationCalls++;
          return { admitted: true, chain: "auto:code" };
        },
      }),
    });
    assert.deepEqual(await model.status(), unavailable);
    assert.equal(verificationCalls, 0);
  }
});
