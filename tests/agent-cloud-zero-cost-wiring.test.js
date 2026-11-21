import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { createVerifiedFreeCloudCodingModel } from "../src/cloud-coding-model.js";
import { createConfiguredFreeLlmApiClient } from "../src/freellmapi-runtime.js";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";
import { manifestDigest } from "../src/freellmapi-zero-cost-verifier.js";

const MODEL = "meta/llama-x:free";
const CHAIN = "auto:or-free";
const KEY = "codebridge-test-key";
const PRIVATE_CONTEXT = "CUSTOMER_CODE_NOT_FOR_UNVERIFIED_PROVIDER";

const env = {
  CODEBRIDGE_FREELLMAPI_PINS_DIR: "/fixture/pins",
  CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR: "/fixture/snaps",
  CODEBRIDGE_OPENROUTER_KEY: "sk-or-v1-" + "a".repeat(24),
};

function build({ ownerEvidence = true, configured = true } = {}) {
  const observedAtEpochMs = Date.now();
  const files = new Map([
    [
      path.join(env.CODEBRIDGE_FREELLMAPI_PINS_DIR, "route-binding-or-free.json"),
      JSON.stringify({
        version: 1,
        chain: CHAIN,
        models: [MODEL],
        sha256: manifestDigest([MODEL]),
      }),
    ],
    [
      path.join(env.CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR, "or-free.json"),
      JSON.stringify({
        version: 1,
        chain: CHAIN,
        observedAtEpochMs,
        members: [{ platform: "openrouter", modelId: MODEL }],
      }),
    ],
  ]);
  const wire = [];
  let posted = 0;
  const configuredFactory = () =>
    createConfiguredFreeLlmApiClient({
      env: configured ? env : {},
      read: async (file) => {
        if (!files.has(file)) throw new Error("UNTRUSTED_SNAPSHOT");
        return files.get(file);
      },
      evidenceRequest: async ({ path: endpoint }) => {
        wire.push(endpoint);
        if (!ownerEvidence) throw new Error("PROVIDER_EVIDENCE_UNAVAILABLE");
        if (endpoint === "/api/v1/key")
          return {
            data: {
              usage: 0,
              usage_daily: 0,
              usage_weekly: 0,
              usage_monthly: 0,
              byok_usage: 0,
              limit_remaining: null,
              effective_budget: null,
              free_model_daily_requests: {
                used: 0,
                limit: 50,
                remaining: 50,
              },
            },
          };
        return {
          data: [
            {
              id: MODEL,
              pricing: { prompt: "0", completion: "0" },
            },
          ],
        };
      },
      factory: (options = {}) =>
        createFreeLlmApiClient({
          ...options,
          apiKey: KEY,
          approvedFreeChains: [CHAIN],
          request: async ({ method }) => {
            if (method === "GET") return { data: [{ id: CHAIN }] };
            posted++;
            return {
              choices: [
                {
                  message: { content: "diff --git a/a.js b/a.js" },
                  finish_reason: "stop",
                },
              ],
            };
          },
        }),
    });
  const cloud = createVerifiedFreeCloudCodingModel({
    authorized: () => true,
    createClient: configuredFactory,
  });
  return {
    cloud,
    wire,
    get posted() {
      return posted;
    },
  };
}

test("agent coding worker uses the same configured zero-cost verifier as the MCP tools", () => {
  const agent = fs.readFileSync("src/agent.js", "utf8");
  const tools = fs.readFileSync("src/tools.js", "utf8");
  assert.match(
    agent,
    /import \{ createConfiguredFreeLlmApiClient \} from "\.\/freellmapi-runtime\.js";/,
  );
  assert.match(
    agent,
    /createVerifiedFreeCloudCodingModel\(\{[\s\S]*?createClient: createConfiguredFreeLlmApiClient,/,
  );
  assert.match(
    tools,
    /freeLlmApiFactory = createConfiguredFreeLlmApiClient/,
  );
  assert.doesNotMatch(
    agent,
    /createVerifiedFreeCloudCodingModel\(\{[\s\S]*?createClient: createFreeLlmApiClient,/,
  );
});

test("no owner-verified provider evidence means zero eligible models and zero outbound prompts", async () => {
  const missing = build({ configured: false });
  assert.deepEqual((await missing.cloud.status()).models, []);
  await assert.rejects(
    missing.cloud.generate({
      model: CHAIN,
      prompt: PRIVATE_CONTEXT,
      maxTokens: 32,
      timeoutSeconds: 10,
    }),
    /FREELLMAPI_ZERO_COST_NOT_ATTESTED/,
  );
  assert.equal(missing.posted, 0);

  const unavailable = build({ ownerEvidence: false });
  assert.deepEqual((await unavailable.cloud.status()).models, []);
  await assert.rejects(
    unavailable.cloud.generate({
      model: CHAIN,
      prompt: PRIVATE_CONTEXT,
      maxTokens: 32,
      timeoutSeconds: 10,
    }),
    /FREELLMAPI_ZERO_COST_NOT_ATTESTED/,
  );
  assert.equal(unavailable.posted, 0);
});

test("synthetic short-lived owner proofs admit only the bound free route before prompt POST", async () => {
  const setup = build();
  assert.deepEqual((await setup.cloud.status()).models, [CHAIN]);
  assert.equal(setup.posted, 0);
  const completion = await setup.cloud.generate({
    model: CHAIN,
    prompt: "NON_PRIVATE_SYNTHETIC_TEST",
    maxTokens: 32,
    timeoutSeconds: 10,
  });
  assert.equal(setup.posted, 1);
  assert.ok(setup.wire.includes("/api/v1/key"));
  assert.ok(setup.wire.includes("/api/v1/models"));
  assert.equal(completion.modelUsage.paidInference, null);
  assert.equal(completion.modelUsage.provider, "freellmapi-loopback");
});
