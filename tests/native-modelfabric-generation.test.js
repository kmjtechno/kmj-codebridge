import test from "node:test";
import assert from "node:assert/strict";
import { createNativeModelFabricGeneration } from "../src/native-modelfabric-generation.js";

const token = "kmjmf_" + "a".repeat(48);
const now = () => 100_000;
const proof = ({ endpoint, policy, requestDigest }) => ({
  source: "trusted_native_account_and_route_verifier",
  endpoint,
  policy,
  requestDigest,
  admissionTicket: "t".repeat(64),
  accountNoChargeVerified: true,
  exactRouteBindingVerified: true,
  noPaidFallback: true,
  privateSourceApproved: true,
  inputPriceUsdPerToken: 0,
  outputPriceUsdPerToken: 0,
  requestsRemaining: 3,
  observedAtEpochMs: now(),
  expiresAtEpochMs: now() + 10_000,
});
const input = {
  model: "modelfabric-auto",
  prompt: "synthetic patch request",
  maxTokens: 4096,
  timeoutSeconds: 90,
  authorizeRequest: () => true,
};
const output = {
  object: "chat.completion",
  modelfabric: { policy: "strict-free-cloud" },
  choices: [
    {
      finish_reason: "stop",
      message: { role: "assistant", content: "synthetic patch" },
    },
  ],
};

test("native generation requires explicit trusted admission before POST", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return Response.json(output);
  };
  for (const verifyAdmission of [
    undefined,
    async () => ({ plannedFreeRoutes: 2 }),
    async (args) => ({ ...proof(args), requestsRemaining: 0 }),
    async (args) => ({ ...proof(args), noPaidFallback: false }),
    async (args) => ({ ...proof(args), expiresAtEpochMs: now() }),
    async (args) => ({ ...proof(args), requestDigest: "wrong" }),
  ]) {
    const client = createNativeModelFabricGeneration({
      token,
      authorized: () => true,
      verifyAdmission,
      request,
      now,
    });
    await assert.rejects(
      client.generate(input),
      /NATIVE_MODEL_FABRIC_NOT_AUTHORIZED/,
    );
  }
  assert.equal(calls, 0);
});

test("native generation uses only fixed origin and bounded policy", async () => {
  let calls = 0;
  const client = createNativeModelFabricGeneration({
    token,
    authorized: () => true,
    verifyAdmission: async (args) => proof(args),
    request: async (url, options) => {
      calls++;
      assert.equal(
        url,
        "https://kmjtechno.com/api/modelfabric/v1/chat/completions",
      );
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["X-ModelFabric-Admission-Ticket"], "t".repeat(64));
      assert.equal(JSON.parse(options.body).max_tokens, 4096);
      assert.equal(JSON.parse(options.body).stream, false);
      return Response.json(output);
    },
    now,
  });
  const result = await client.generate(input);
  assert.equal(result.response, "synthetic patch");
  assert.equal(result.billingVerified, false);
  assert.equal(result.outputIsUntrusted, true);
  assert.equal(calls, 1);
});

test("consent revoked during admission blocks all prompt transfer", async () => {
  let approved = true;
  let calls = 0;
  const client = createNativeModelFabricGeneration({
    token,
    authorized: () => approved,
    verifyAdmission: async (args) => {
      approved = false;
      return proof(args);
    },
    request: async () => {
      calls++;
      return Response.json(output);
    },
    now,
  });
  await assert.rejects(client.generate(input));
  assert.equal(calls, 0);
});

test("incomplete or policy-mismatched output cannot become a patch", async () => {
  for (const response of [
    Response.json({
      ...output,
      choices: [{ ...output.choices[0], finish_reason: "length" }],
    }),
    Response.json({
      ...output,
      modelfabric: { policy: "default" },
    }),
    new Response("x".repeat(262145)),
  ]) {
    const client = createNativeModelFabricGeneration({
      token,
      authorized: () => true,
      verifyAdmission: async (args) => proof(args),
      request: async () => response,
      now,
    });
    await assert.rejects(client.generate(input));
  }
});
