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

test("cloud discovery drops verified admissions when consent is revoked mid-verification", async () => {
  let consent = true;
  let checks = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({
      status: async () => ({
        available: true,
        approvedFreeChains: ["auto:first", "auto:second"],
      }),
      checkZeroCostChain: async ({ chain }) => {
        checks++;
        consent = false;
        return { admitted: true, chain };
      },
    }),
  });
  assert.deepEqual(await model.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
  assert.equal(checks, 1, "revoked consent must prevent additional verification");
});
