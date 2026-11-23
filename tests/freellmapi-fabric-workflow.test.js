import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectFabricCatalog,
  selectFabricCandidates,
  TASK_ROUTE_PREFERENCES,
} from "../src/freellmapi-fabric-policy.js";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const key = "freellmapi-test-key-2026";
const proof = ({ chain, observedAtEpochMs }) => ({
  source: "authenticated_provider_billing_and_route_binding",
  chain,
  routeBindingVerified: true,
  accountNoChargeVerified: true,
  noPaidFallback: true,
  inputPriceUsdPerToken: 0,
  outputPriceUsdPerToken: 0,
  requestsRemaining: 2,
  observedAtEpochMs,
  expiresAtEpochMs: observedAtEpochMs + 30000,
});
const catalog = [
  { id: "auto:code", available: true, execution_status: "ready" },
  { id: "auto:default", available: true, execution_status: "ready" },
  { id: "auto:smart", available: false, execution_status: "needsKey" },
  { id: "auto:fast", available: true, execution_status: "exhausted" },
  { id: "vendor/paid-model", available: true, execution_status: "ready" },
];

test("fabric projection uses only owner allowlisted auto profiles; unknown cost never counts as admitted", () => {
  const fabric = inspectFabricCatalog(
    catalog,
    ["auto:code", "auto:smart", "auto:fast", "auto:default"],
    1000000,
  );
  assert.equal(fabric.modelCount, 5);
  assert.equal(fabric.approvedChainCount, 4);
  assert.equal(fabric.inferenceReady, false);
  assert.deepEqual(selectFabricCandidates(fabric, "code"), [
    "auto:code",
    "auto:default",
  ]);
  assert.deepEqual(selectFabricCandidates(fabric, "fast"), ["auto:default"]);
  assert.deepEqual(selectFabricCandidates(fabric, "reasoning"), [
    "auto:default",
  ]);
  assert.deepEqual(selectFabricCandidates(fabric, "code", "auto:fast"), []);
  assert.ok(
    fabric.routes.every(
      (r) => r.billingProof === "NOT_PROVEN_BY_ROUTER_CATALOG",
    ),
  );
  assert.ok(!JSON.stringify(fabric).includes("vendor/paid-model"));
});

test("invalid, repeated or forged catalog/profile data is rejected", () => {
  assert.throws(
    () =>
      inspectFabricCatalog(
        [{ id: "auto:code" }, { id: "auto:code" }],
        ["auto:code"],
        10,
      ),
    /FREELLMAPI_BAD_RESPONSE/,
  );
  assert.throws(
    () => inspectFabricCatalog(catalog, ["auto:../../etc"], 10),
    /FREELLMAPI_INVALID_CATALOG/,
  );
  assert.throws(
    () => inspectFabricCatalog(catalog, [], -1),
    /FREELLMAPI_INVALID_CATALOG/,
  );
  assert.throws(
    () => selectFabricCandidates(null, "code"),
    /FREELLMAPI_INVALID_ROUTE_PLAN/,
  );
  assert.equal(Object.isFrozen(TASK_ROUTE_PREFERENCES), true);
});

test("owner-pinned named profiles outrank global auto-sort aliases", () => {
  const overview = inspectFabricCatalog(
    [
      { id: "auto:general", available: true, execution_status: "ready" },
      { id: "auto:quick", available: true, execution_status: "ready" },
      { id: "auto:fast", available: true, execution_status: "ready" },
      { id: "auto:balanced", available: true, execution_status: "ready" },
    ],
    ["auto:general", "auto:quick", "auto:fast", "auto:balanced"],
    1000000,
  );
  assert.deepEqual(selectFabricCandidates(overview, "fast"), [
    "auto:quick",
    "auto:fast",
  ]);
  assert.deepEqual(selectFabricCandidates(overview, "general"), [
    "auto:general",
    "auto:balanced",
  ]);
  assert.equal(overview.inferenceReady, false);
});

test("a sole owner-approved custom profile is routed automatically for all tasks", async () => {
  const custom = [
    { id: "auto:or-free", available: true, execution_status: "ready" },
  ];
  const projected = inspectFabricCatalog(custom, ["auto:or-free"], 1000000);
  for (const task of ["code", "fast", "reasoning", "general"]) {
    assert.deepEqual(selectFabricCandidates(projected, task), ["auto:or-free"]);
  }
  let admitted = 0;
  const requests = [];
  const client = createFreeLlmApiClient({
    apiKey: key,
    approvedFreeChains: ["auto:or-free"],
    verifyZeroCostChain: (args) => {
      admitted += 1;
      return proof(args);
    },
    request: async (request) => {
      if (request.path === "/v1/models") return { data: custom };
      requests.push(request);
      return {
        choices: [
          { message: { content: "safe advisory only" }, finish_reason: "stop" },
        ],
      };
    },
  });
  const result = await client.generateRouted({
    task: "code",
    prompt: "Review this bounded task",
    localProcessingApproved: true,
    upstreamCloudApproved: true,
  });
  assert.equal(result.routing.chosen, "auto:or-free");
  assert.equal(result.outputIsUntrusted, true);
  assert.equal(admitted, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, "auto:or-free");
});

test("multiple unknown profile names are never guessed; exhausted sole route stays denied", () => {
  const two = inspectFabricCatalog(
    [
      { id: "auto:or-free", available: true, execution_status: "ready" },
      { id: "auto:backup-free", available: true, execution_status: "ready" },
    ],
    ["auto:or-free", "auto:backup-free"],
    1000000,
  );
  assert.deepEqual(selectFabricCandidates(two, "code"), []);
  assert.deepEqual(selectFabricCandidates(two, "fast"), []);
  const exhausted = inspectFabricCatalog(
    [{ id: "auto:or-free", available: true, execution_status: "exhausted" }],
    ["auto:or-free"],
    1000000,
  );
  assert.deepEqual(selectFabricCandidates(exhausted, "code"), []);
});

test("cooldown demotes only the affected approved route, not the entire model pool", () => {
  const cooling = new Map([["auto:code", 1010000]]);
  const before = inspectFabricCatalog(
    catalog,
    ["auto:code", "auto:default"],
    1000000,
    cooling,
  );
  assert.deepEqual(selectFabricCandidates(before, "code"), ["auto:default"]);
  const after = inspectFabricCatalog(
    catalog,
    ["auto:code", "auto:default"],
    1010000,
    cooling,
  );
  assert.deepEqual(selectFabricCandidates(after, "code"), [
    "auto:code",
    "auto:default",
  ]);
});

test("read-only fabric inspection and opt-in usage counters never leak key inventory or claim free billing", async () => {
  const calls = [];
  const client = createFreeLlmApiClient({
    apiKey: key,
    approvedFreeChains: ["auto:code", "auto:default"],
    request: async ({ method, path }) => {
      calls.push([method, path]);
      if (path === "/v1/models") return { data: catalog };
      if (path === "/v1/usage")
        return {
          month: "2026-11",
          requests: 24,
          tokens: 3900,
          byKey: [
            {
              keyId: 1337,
              label: "PRIVATE_OWNER_KEY_LABEL",
              platform: "secret",
            },
          ],
        };
      throw new Error("unexpected network path");
    },
  });
  const status = await client.status();
  assert.equal(status.fabric.eligibleCandidateCount, 2);
  assert.equal(Object.hasOwn(status, "usage"), false);
  const withUsage = await client.status({ includeUsage: true });
  assert.deepEqual(withUsage.usage, {
    state: "ROUTER_USAGE_OBSERVED",
    month: "2026-11",
    requests: 24,
    tokens: 3900,
    keyDetails: "REDACTED",
    spendOrBillingProof: "NOT_VERIFIED",
  });
  assert.deepEqual(calls, [
    ["GET", "/v1/models"],
    ["GET", "/v1/models"],
    ["GET", "/v1/usage"],
  ]);
  assert.ok(!JSON.stringify(withUsage).includes("PRIVATE_OWNER_KEY_LABEL"));
  assert.ok(!JSON.stringify(withUsage).includes(key));
});

test("unavailable usage endpoint is not a cloud prompt and never becomes a spend attestation", async () => {
  const client = createFreeLlmApiClient({
    apiKey: key,
    approvedFreeChains: ["auto:default"],
    request: async ({ path }) =>
      path === "/v1/models"
        ? { data: [{ id: "auto:default" }] }
        : Promise.reject(new Error("unsupported")),
  });
  const result = await client.status({ includeUsage: true });
  assert.equal(result.usage.state, "ROUTER_USAGE_UNAVAILABLE");
  assert.equal(result.usage.spendOrBillingProof, "NOT_VERIFIED");
});

test("a 429 route is demoted on the next call; each cloud POST has independent authenticated route proof", async () => {
  let clock = 1000000;
  let admissions = 0;
  const sent = [];
  const client = createFreeLlmApiClient({
    apiKey: key,
    approvedFreeChains: ["auto:code", "auto:default"],
    now: () => clock,
    verifyZeroCostChain: (args) => {
      admissions += 1;
      return proof(args);
    },
    request: async (request) => {
      if (request.path === "/v1/models")
        return {
          data: [
            { id: "auto:code", available: true, execution_status: "ready" },
            { id: "auto:default", available: true, execution_status: "ready" },
          ],
        };
      sent.push([request.body.model, request.taskType]);
      if (request.body.model === "auto:code")
        throw new Error("FREELLMAPI_QUOTA_EXHAUSTED");
      return {
        choices: [
          { message: { content: "code review" }, finish_reason: "stop" },
        ],
      };
    },
  });
  const args = {
    task: "code",
    prompt: "Check this safe snippet",
    localProcessingApproved: true,
    upstreamCloudApproved: true,
  };
  const first = await client.generateRouted(args);
  assert.equal(first.routing.chosen, "auto:default");
  const second = await client.generateRouted(args);
  assert.equal(second.routing.chosen, "auto:default");
  assert.deepEqual(sent, [
    ["auto:code", "code"],
    ["auto:default", "code"],
    ["auto:default", "code"],
  ]);
  assert.equal(admissions, 3);
  clock += 31000;
  const third = await client.generateRouted(args);
  assert.equal(third.routing.chosen, "auto:default");
  assert.deepEqual(sent.at(-2), ["auto:code", "code"]);
  assert.equal(admissions, 5);
});

test("blocked or unverified selected route cannot generate and no alternative paid provider is tried", async () => {
  const sent = [];
  const client = createFreeLlmApiClient({
    apiKey: key,
    approvedFreeChains: ["auto:smart"],
    request: async (r) => {
      if (r.path === "/v1/models") return { data: catalog };
      sent.push(r);
      throw new Error("MUST_NOT_REACH_CLOUD");
    },
  });
  await assert.rejects(
    client.generateRouted({
      task: "reasoning",
      prompt: "secret",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    }),
    { message: "FREELLMAPI_NO_APPROVED_CHAIN" },
  );
  assert.equal(sent.length, 0);
});

test("non-429 failures are never retried to another chain", async () => {
  let posts = 0;
  const client = createFreeLlmApiClient({
    apiKey: key,
    approvedFreeChains: ["auto:code", "auto:default"],
    verifyZeroCostChain: proof,
    request: async (r) => {
      if (r.path === "/v1/models") return { data: catalog };
      posts += 1;
      throw new Error("FREELLMAPI_TIMEOUT");
    },
  });
  await assert.rejects(
    client.generateRouted({
      task: "code",
      prompt: "no ambiguous retry",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    }),
    { message: "FREELLMAPI_TIMEOUT" },
  );
  assert.equal(posts, 1);
});
