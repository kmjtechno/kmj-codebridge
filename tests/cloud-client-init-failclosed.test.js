import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

test("cloud discovery fails closed when trusted client initialization throws", async () => {
  let attempts = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => {
      attempts++;
      throw new Error("NO_TRUSTED_CLIENT");
    },
  });
  assert.deepEqual(await model.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
  assert.equal(attempts, 1);
});

test("invalid cloud chain is rejected before client initialization or prompt transfer", async () => {
  let attempts = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => {
      attempts++;
      throw new Error("MUST_NOT_INITIALIZE");
    },
  });
  for (const chain of ["local:code", "auto:", "auto:code/paid", "auto:code\n"]) {
    await assert.rejects(
      model.generate({ model: chain, prompt: "PRIVATE_SOURCE" }),
      /CLOUD_CODING_CHAIN_INVALID/,
    );
  }
  assert.equal(attempts, 0);
});
