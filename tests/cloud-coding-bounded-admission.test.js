import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

test("cloud discovery bounds unique zero-cost verification to 32 of first 256 advertised chains", async () => {
  const checked = [];
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () => ({
        available: true,
        approvedFreeChains: [
          ...Array.from({ length: 300 }, (_, i) => `auto:c${i}`),
          "auto:late",
        ],
      }),
      checkZeroCostChain: async ({ chain }) => {
        checked.push(chain);
        return { admitted: true, chain };
      },
    }),
  });
  const status = await model.status();
  assert.deepEqual(checked, Array.from({ length: 32 }, (_, i) => `auto:c${i}`));
  assert.deepEqual(status.models, checked);
  assert.equal(status.available, true);
  assert.equal(status.activeRequest, false);
});

test("cloud discovery deduplicates chains before zero-cost verification", async () => {
  const checked = [];
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({
      status: async () => ({
        available: true,
        approvedFreeChains: ["auto:code", "auto:code", "local:unsafe", "auto:other"],
      }),
      checkZeroCostChain: async ({ chain }) => {
        checked.push(chain);
        return { admitted: chain === "auto:code", chain };
      },
    }),
  });
  assert.deepEqual(await model.status(), {
    available: true,
    activeRequest: false,
    models: ["auto:code"],
  });
  assert.deepEqual(checked, ["auto:code", "auto:other"]);
});
