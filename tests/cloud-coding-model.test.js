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

test("cloud coding stays offline and never initializes a client without explicit owner permission", async () => {
  let calls = 0;
  const model = createVerifiedFreeCloudCodingModel({
    createClient: () => {
      calls++;
      throw new Error("MUST_NOT_CONNECT");
    },
  });
  assert.deepEqual(await model.status(), {
    available: false,
    activeRequest: false,
    models: [],
  });
  await assert.rejects(
    model.generate({ model: "auto:code", prompt: "private source" }),
    /CLOUD_CODING_NOT_AUTHORIZED/,
  );
  assert.equal(calls, 0);
});

test("cloud coding uses only device-approved discovered chains and reports truthful attribution", async () => {
  let authorized = true;
  const sent = [];
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => authorized,
    createClient: () => ({
      status: async () => ({
        available: true,
        chains: ["auto:code", "auto:paid"],
        approvedFreeChains: ["auto:code"],
      }),
      checkZeroCostChain: async ({ chain }) => ({ admitted: true, chain }),
      generate: async (args) => {
        sent.push(args);
        return receipt(args.chain);
      },
    }),
  });
  assert.deepEqual((await model.status()).models, ["auto:code"]);
  const output = await model.generate({
    model: "auto:code",
    prompt: "private source",
    maxTokens: 256,
    timeoutSeconds: 10,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chain, "auto:code");
  assert.equal(sent[0].localProcessingApproved, true);
  assert.equal(sent[0].upstreamCloudApproved, true);
  assert.deepEqual(output.modelUsage, cloudCodingReceipt("auto:code"));
  assert.deepEqual(normalizeModelReceipt(output.modelUsage), output.modelUsage);
  assert.equal(output.modelUsage.paidInference, null);
  assert.equal(output.modelUsage.provider, "freellmapi-loopback");
  assert.equal(
    JSON.stringify(output.modelUsage).includes("private source"),
    false,
  );
  authorized = false;
  await assert.rejects(
    model.generate({ model: "auto:code", prompt: "private source" }),
    /CLOUD_CODING_NOT_AUTHORIZED/,
  );
  assert.equal(sent.length, 1);
});

test("cloud source consent revoked during discovery or generation cannot authorize further work", async () => {
  let consent = true;
  let generated = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({
      status: async () => {
        consent = false;
        return { available: true, approvedFreeChains: ["auto:code"] };
      },
      generate: async () => {
        generated++;
        return receipt();
      },
    }),
  });
  assert.deepEqual((await model.status()).models, []);
  await assert.rejects(
    model.generate({ model: "auto:code", prompt: "code" }),
    /CLOUD_CODING_NOT_AUTHORIZED/,
  );
  assert.equal(generated, 0);
  consent = true;
  const during = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({
      status: async () => ({
        available: true,
        approvedFreeChains: ["auto:code"],
      }),
      generate: async () => {
        consent = false;
        return receipt();
      },
    }),
  });
  await assert.rejects(
    during.generate({ model: "auto:code", prompt: "code" }),
    /CLOUD_CODING_NOT_AUTHORIZED/,
  );
});

test("cloud adapter refuses false provider, route, billing and model claims", async () => {
  const patches = [
    { provider: "local-ollama" },
    { chain: "auto:other" },
    { zeroCostRouteAdmissionVerified: false },
    { paidInference: false },
    { billingVerified: true },
    { actualUpstreamModel: "hidden-vendor" },
    { cloudFallback: "paid-backup" },
    { outputIsUntrusted: false },
    { response: "" },
    { response: "   " },
    { response: null },
    { response: { patch: "not text" } },
    { response: "diff --git a/a b/b\0malformed" },
    { response: "x".repeat(1_048_577) },
  ];
  for (const patch of patches) {
    const model = createVerifiedFreeCloudCodingModel({
      authorized: () => true,
      createClient: () => ({
        generate: async () => ({ ...receipt(), ...patch }),
      }),
    });
    await assert.rejects(
      model.generate({ model: "auto:code", prompt: "private" }),
      /CLOUD_CODING_ATTESTATION_INVALID/,
    );
  }
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () => ({ generate: async () => receipt() }),
  });
  await assert.rejects(
    model.generate({ model: "local:qwen", prompt: "private" }),
    /CLOUD_CODING_CHAIN_INVALID/,
  );
});

test("no trusted zero-cost attestor means no upstream cloud POST, even with explicit consent", async () => {
  let posts = 0;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: () =>
      createFreeLlmApiClient({
        apiKey: "codebridge-test-key",
        approvedFreeChains: ["auto:code"],
        request: async ({ method }) => {
          if (method === "GET") return { data: [{ id: "auto:code" }] };
          posts++;
          return { choices: [] };
        },
      }),
  });
  assert.deepEqual((await model.status()).models, []);
  await assert.rejects(
    model.generate({
      model: "auto:code",
      prompt: "PRIVATE_CODE_NEVER_SENT",
      maxTokens: 256,
      timeoutSeconds: 10,
    }),
    /FREELLMAPI_ZERO_COST_NOT_ATTESTED/,
  );
  assert.equal(posts, 0);
});

test("cloud status rejects mismatched and unverified zero-cost attestations", async () => {
  const proofs = [
    { admitted: false, chain: "auto:code" },
    { admitted: true, chain: "auto:other" },
    { admitted: "true", chain: "auto:code" },
    null,
  ];
  for (const proof of proofs) {
    let calls = 0;
    const model = createVerifiedFreeCloudCodingModel({
      authorized: () => true,
      createClient: () => ({
        status: async () => ({
          available: true,
          approvedFreeChains: ["auto:code"],
        }),
        checkZeroCostChain: async () => {
          calls++;
          return proof;
        },
        generate: async () => {
          throw new Error("MUST_NOT_GENERATE");
        },
      }),
    });
    assert.deepEqual(await model.status(), {
      available: false,
      activeRequest: false,
      models: [],
    });
    assert.equal(calls, 1);
  }
});

test("cloud status fails closed when consent is revoked during zero-cost verification", async () => {
  let consent = true;
  const model = createVerifiedFreeCloudCodingModel({
    authorized: () => consent,
    createClient: () => ({
      status: async () => ({
        available: true,
        approvedFreeChains: ["auto:code"],
      }),
      checkZeroCostChain: async ({ chain }) => {
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
});
