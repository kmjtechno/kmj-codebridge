import test from "node:test";
import assert from "node:assert/strict";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const CHAIN = "auto:code";
const NOW = 1000000;
const PROOF = {
  source: "authenticated_provider_billing_and_route_binding",
  chain: CHAIN,
  routeBindingVerified: true,
  accountNoChargeVerified: true,
  noPaidFallback: true,
  inputPriceUsdPerToken: 0,
  outputPriceUsdPerToken: 0,
  requestsRemaining: 3,
  observedAtEpochMs: NOW,
  expiresAtEpochMs: NOW + 30000,
};
const INPUT = {
  chain: CHAIN,
  prompt: "synthetic public test only",
  localProcessingApproved: true,
  upstreamCloudApproved: true,
};

function clientWith(fakeGet, fakePost) {
  const requests = [];
  const client = createFreeLlmApiClient({
    apiKey: "synthetic-testing-key",
    approvedFreeChains: [CHAIN],
    now: () => NOW,
    verifyZeroCostChain: async () => PROOF,
    request: async ({ method, path, body }) => {
      requests.push({ method, path, body });
      return method === "GET" ? fakeGet : fakePost;
    },
  });
  return { client, requests };
}

test("model catalog rejects missing, wrong-shape, and partially corrupt rows before cloud POST", async () => {
  const invalid = [
    {},
    { data: null },
    { data: {} },
    { data: "auto:code" },
    { data: 42 },
    { data: [null] },
    { data: [42] },
    { data: ["auto:code"] },
    { data: [{ id: 42 }] },
    { data: [{ id: CHAIN }, null] },
    { data: [{ id: CHAIN }, { id: ["other"] }] },
  ];
  for (const catalog of invalid) {
    const { client, requests } = clientWith(catalog, null);
    await assert.rejects(client.status(), {
      code: "FREELLMAPI_BAD_RESPONSE",
    });
    await assert.rejects(
      client.generateRouted({
        task: "code",
        prompt: "synthetic public test only",
        localProcessingApproved: true,
        upstreamCloudApproved: true,
      }),
      { code: "FREELLMAPI_BAD_RESPONSE" },
    );
    assert.equal(
      requests.filter((r) => r.method === "POST").length,
      0,
      JSON.stringify(catalog),
    );
  }
});

test("valid empty catalog reports zero models but cannot choose a route", async () => {
  const { client, requests } = clientWith({ data: [] }, null);
  assert.deepEqual((await client.status()).chains, []);
  await assert.rejects(
    client.generateRouted({
      task: "code",
      prompt: "synthetic public test only",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    }),
    { code: "FREELLMAPI_NO_APPROVED_CHAIN" },
  );
  assert.equal(requests.some((r) => r.method === "POST"), false);
});

test("malformed completions are not reported as successful inference", async () => {
  const invalid = [
    {},
    { choices: null },
    { choices: {} },
    { choices: [] },
    { choices: [null] },
    { choices: [42] },
    { choices: [{ message: null, finish_reason: "stop" }] },
    { choices: [{ message: { content: 42 }, finish_reason: "stop" }] },
    { choices: [{ message: { content: "" }, finish_reason: "stop" }] },
    { choices: [{ message: { content: "ok" } }] },
    { choices: [{ message: { content: "ok" }, finish_reason: "content_filter" }] },
  ];
  for (const completion of invalid) {
    const { client, requests } = clientWith(
      { data: [{ id: CHAIN }] },
      completion,
    );
    await assert.rejects(client.generate(INPUT), {
      code: "FREELLMAPI_BAD_COMPLETION",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
  }
});

test("valid text responses preserve stop and length semantics", async () => {
  for (const finish_reason of ["stop", "length"]) {
    const { client, requests } = clientWith(
      { data: [{ id: CHAIN }] },
      { choices: [{ message: { content: "verified" }, finish_reason }] },
    );
    const output = await client.generate(INPUT);
    assert.equal(output.response, "verified");
    assert.equal(output.hitTokenLimit, finish_reason === "length");
    assert.equal(output.outputIsUntrusted, true);
    assert.equal(requests.length, 1);
  }
});
