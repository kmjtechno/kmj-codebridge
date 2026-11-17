import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createConfiguredFreeLlmApiClient,
  zeroCostConfigured,
} from "../src/freellmapi-runtime.js";
import { manifestDigest } from "../src/freellmapi-zero-cost-verifier.js";

const NOW = 1_800_000_000_000;
const IDS = ["meta/llama-x:free"];
const ENV = {
  CODEBRIDGE_FREELLMAPI_PINS_DIR: "/pins",
  CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR: "/snaps",
  CODEBRIDGE_OPENROUTER_KEY: "sk-or-v1-" + "a".repeat(24),
};
const files = (over = {}) => ({
  "/pins/route-binding-or-free.json": JSON.stringify({
    version: 1,
    chain: "auto:or-free",
    models: IDS,
    sha256: manifestDigest(IDS),
  }),
  "/snaps/or-free.json": JSON.stringify({
    version: 1,
    chain: "auto:or-free",
    observedAtEpochMs: Date.now(),
    members: [{ platform: "openrouter", modelId: IDS[0] }],
  }),
  ...over,
});
const reader = (map) => async (p) => {
  if (!(p in map)) throw new Error("ENOENT");
  return map[p];
};
const evidence = async ({ path: p }) =>
  p === "/api/v1/key"
    ? {
        data: {
          usage: 0,
          usage_daily: 0,
          usage_weekly: 0,
          usage_monthly: 0,
          byok_usage: 0,
          limit_remaining: null,
          effective_budget: null,
          free_model_daily_requests: { used: 1, limit: 50, remaining: 49 },
        },
      }
    : { data: [{ id: IDS[0], pricing: { prompt: "0", completion: "0" } }] };

test("without all three env vars the plain client is returned (no verifier)", () => {
  for (const drop of Object.keys(ENV)) {
    const env = { ...ENV };
    delete env[drop];
    let args;
    createConfiguredFreeLlmApiClient({
      env,
      factory: (...a) => (args = a),
    });
    assert.deepEqual(args, []);
  }
  assert.equal(
    zeroCostConfigured({ ...ENV, CODEBRIDGE_FREELLMAPI_PINS_DIR: "rel" }),
    false,
  );
  assert.equal(zeroCostConfigured(ENV), true);
});

test("configured: the injected verifier admits only when manifest, snapshot and evidence agree", async () => {
  const make = (map, ev = evidence) => {
    let verifier;
    createConfiguredFreeLlmApiClient({
      env: ENV,
      read: reader(map),
      evidenceRequest: ev,
      factory: (o) => (verifier = o.verifyZeroCostChain),
    });
    return verifier;
  };
  const proof = await make(files())({
    chain: "auto:or-free",
    observedAtEpochMs: NOW,
  });
  assert.equal(proof.routeBindingVerified, true);
  await assert.rejects(
    make(files({ "/pins/route-binding-or-free.json": "{}" }))({
      chain: "auto:or-free",
      observedAtEpochMs: NOW,
    }),
  );
  await assert.rejects(
    make(files({ "/snaps/or-free.json": "x" }))({
      chain: "auto:or-free",
      observedAtEpochMs: NOW,
    }),
  );
  await assert.rejects(
    make(files(), async () => {
      throw Object.assign(new Error("x"), { code: "OPENROUTER_HTTP_402" });
    })({ chain: "auto:or-free", observedAtEpochMs: NOW }),
  );
});

test("chain names cannot escape the pins or snapshot directories", async () => {
  let verifier;
  createConfiguredFreeLlmApiClient({
    env: ENV,
    read: async (p) => {
      throw new Error("READ " + p);
    },
    evidenceRequest: evidence,
    factory: (o) => (verifier = o.verifyZeroCostChain),
  });
  for (const chain of ["auto:../x", "auto:a/b", "auto:..", "or-free"]) {
    await assert.rejects(
      verifier({ chain, observedAtEpochMs: NOW }),
      (e) => !String(e.message).startsWith("READ"),
    );
  }
});

test("tools.js defaults to the configured factory; gateway tool set is unchanged", () => {
  const t = fs.readFileSync("src/tools.js", "utf8");
  assert.match(t, /freeLlmApiFactory = createConfiguredFreeLlmApiClient/);
  assert.ok(!/from "\.\/freellmapi-zero-cost-verifier\.js"/.test(t));
  const dir = fs.readdirSync("src").filter((f) => f.endsWith(".js"));
  const importers = dir.filter((f) =>
    /freellmapi-runtime/.test(fs.readFileSync(path.join("src", f), "utf8")),
  );
  assert.deepEqual(
    importers.sort(),
    ["freellmapi-runtime.js", "tools.js"].filter(
      (f) => f !== "freellmapi-runtime.js",
    ),
  );
});
