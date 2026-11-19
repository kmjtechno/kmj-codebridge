import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";

const unavailable = { available: false, activeRequest: false, models: [] };

test("cloud consent must be synchronous literal true; truthy or asynchronous values never connect", async () => {
  for (const value of [1, "true", {}, Promise.resolve(true), null, undefined]) {
    let clients = 0;
    const model = createVerifiedFreeCloudCodingModel({
      authorized: () => value,
      createClient: () => {
        clients++;
        throw new Error("CLIENT_MUST_NOT_BE_CREATED");
      },
    });
    assert.deepEqual(await model.status(), unavailable);
    await assert.rejects(
      model.generate({ model: "auto:code", prompt: "PRIVATE_SOURCE" }),
      /CLOUD_CODING_NOT_AUTHORIZED/,
    );
    assert.equal(clients, 0);
  }
});

test("throwing consent getter denies both discovery and generation without initializing client", async () => {
  let clients = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => {
      throw new Error("UNTRUSTED_CONSENT_PROVIDER");
    },
    createClient: () => {
      clients++;
      throw new Error("CLIENT_MUST_NOT_BE_CREATED");
    },
  });
  assert.deepEqual(await model.status(), unavailable);
  await assert.rejects(
    model.generate({ model: "auto:code", prompt: "PRIVATE_SOURCE" }),
    /CLOUD_CODING_NOT_AUTHORIZED/,
  );
  assert.equal(clients, 0);
});

test("invalid cloud chain is rejected before creating any client", async () => {
  let clients = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => {
      clients++;
      throw new Error("CLIENT_MUST_NOT_BE_CREATED");
    },
  });
  for (const chain of ["local:qwen", "auto:paid/backup", "auto:", "auto:" + "x".repeat(21), null]) {
    await assert.rejects(
      model.generate({ model: chain, prompt: "PRIVATE_SOURCE" }),
      /CLOUD_CODING_CHAIN_INVALID/,
    );
  }
  assert.equal(clients, 0);
});
