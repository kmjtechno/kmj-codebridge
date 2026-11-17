import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createZeroCostVerifier,
  manifestDigest,
} from "../src/freellmapi-zero-cost-verifier.js";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const NOW = 1_800_000_000_000;
const CHAIN = "auto:free-code";
const IDS = ["meta/llama-x:free", "vendor/model-a:free"];
const manifest = (patch = {}) => ({
  version: 1,
  chain: CHAIN,
  models: IDS,
  sha256: manifestDigest(IDS),
  ...patch,
});
const key = (patch = {}) => ({
  data: {
    usage: 0,
    usage_daily: 0,
    usage_weekly: 0,
    usage_monthly: 0,
    byok_usage: 0,
    limit_remaining: null,
    effective_budget: null,
    free_model_daily_requests: { used: 3, limit: 50, remaining: 47 },
    ...patch,
  },
});
const catalog = (over = {}) => ({
  data: IDS.map((id) => ({
    id,
    pricing: over[id] ?? { prompt: "0", completion: "0" },
  })),
});
const io = (o = {}) => ({
  readManifest: async () => manifest(),
  readLiveChainMembers: async () =>
    IDS.map((modelId) => ({ platform: "openrouter", modelId })),
  fetchOpenRouterKey: async () => key(),
  fetchOpenRouterModels: async () => catalog(),
  ...o,
});
const run = (o) =>
  createZeroCostVerifier(io(o))({ chain: CHAIN, observedAtEpochMs: NOW });
const denied = (o) =>
  assert.rejects(run(o), { message: "ZERO_COST_NOT_ATTESTED" });

test("pinned manifest, matching live members, zero spend and zero prices give a proof", async () => {
  const p = await run();
  assert.equal(p.chain, CHAIN);
  assert.equal(p.routeBindingVerified, true);
  assert.equal(p.accountNoChargeVerified, true);
  assert.equal(p.requestsRemaining, 47);
});

test("manifest tampering, wrong chain or bad digest is denied", async () => {
  await denied({
    readManifest: async () => manifest({ sha256: "0".repeat(64) }),
  });
  await denied({ readManifest: async () => manifest({ chain: "auto:other" }) });
  await denied({ readManifest: async () => manifest({ version: 2 }) });
  const paid = ["meta/llama-x", "vendor/model-a:free"];
  await denied({
    readManifest: async () =>
      manifest({ models: paid, sha256: manifestDigest(paid) }),
  });
});

test("router drift is denied: extra, missing, swapped or non-openrouter members", async () => {
  const member = (modelId, platform = "openrouter") => ({ platform, modelId });
  await denied({
    readLiveChainMembers: async () =>
      [...IDS, "x/y:free"].map((m) => member(m)),
  });
  await denied({ readLiveChainMembers: async () => [member(IDS[0])] });
  await denied({
    readLiveChainMembers: async () => [member(IDS[0]), member("x/y:free")],
  });
  await denied({
    readLiveChainMembers: async () => [member(IDS[0]), member(IDS[1], "groq")],
  });
});

test("any non-zero price, missing model or recorded spend is denied", async () => {
  await denied({
    fetchOpenRouterModels: async () =>
      catalog({ [IDS[0]]: { prompt: "0.000001", completion: "0" } }),
  });
  await denied({
    fetchOpenRouterModels: async () => ({ data: [catalog().data[0]] }),
  });
  await denied({ fetchOpenRouterKey: async () => key({ usage: 0.01 }) });
  await denied({
    fetchOpenRouterKey: async () =>
      key({ free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } }),
  });
});

test("IO failures propagate as throws and bad chain names are denied", async () => {
  await assert.rejects(
    run({
      fetchOpenRouterKey: async () => {
        throw new Error("net");
      },
    }),
  );
  await assert.rejects(
    createZeroCostVerifier(io())({ chain: "auto", observedAtEpochMs: NOW }),
    { message: "ZERO_COST_NOT_ATTESTED" },
  );
  assert.throws(() => createZeroCostVerifier({}), {
    message: "VERIFIER_IO_MISSING",
  });
});

test("the adapter admits a chain only through this verifier", async () => {
  const mk = (o) =>
    createFreeLlmApiClient({
      apiKey: "k".repeat(24),
      approvedFreeChains: [CHAIN],
      verifyZeroCostChain: createZeroCostVerifier(io(o)),
      now: () => NOW,
    });
  assert.deepEqual(await mk().checkZeroCostChain({ chain: CHAIN }), {
    admitted: true,
    chain: CHAIN,
  });
  await assert.rejects(
    mk({
      fetchOpenRouterKey: async () => key({ usage: 1 }),
    }).checkZeroCostChain({ chain: CHAIN }),
    { code: "FREELLMAPI_ZERO_COST_NOT_ATTESTED" },
  );
});

test("module is pure and imported only by the opt-in runtime assembly", () => {
  const text = fs
    .readFileSync("src/freellmapi-zero-cost-verifier.js", "utf8")
    .replace(/\/\/.*$/gm, "");
  assert.ok(
    !/\b(fetch|http|https|node:net|process\.env|child_process|readFile)\b/.test(
      text,
    ),
  );
  const importers = fs
    .readdirSync("src")
    .filter(
      (f) => f.endsWith(".js") && f !== "freellmapi-zero-cost-verifier.js",
    )
    .filter((f) =>
      /freellmapi-zero-cost-verifier/.test(
        fs.readFileSync(path.join("src", f), "utf8"),
      ),
    );
  assert.deepEqual(importers, ["freellmapi-runtime.js"]);
});
