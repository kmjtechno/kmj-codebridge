import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PROOF_SOURCE,
  buildZeroCostProof,
  evaluateAccountEvidence,
  isVerifiedFreeModel,
} from "../src/openrouter-free-evidence.js";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

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
const model = (
  id = "meta/llama-x:free",
  pricing = { prompt: "0", completion: "0" },
) => ({ id, pricing });
const binding = (patch = {}) => ({
  chain: "auto:code",
  verified: true,
  noPaidFallback: true,
  models: [model()],
  ...patch,
});
const NOW = 1_800_000_000_000;
const build = (o = {}) =>
  buildZeroCostProof({
    chain: "auto:code",
    observedAtEpochMs: NOW,
    keyResponse: key(),
    routeBinding: binding(),
    ...o,
  });

test("zero spend, free quota and a verified free route give a proof", () => {
  const p = build();
  assert.equal(p.source, PROOF_SOURCE);
  assert.equal(p.requestsRemaining, 47);
  assert.equal(p.expiresAtEpochMs - p.observedAtEpochMs, 30000);
  assert.equal(p.inputPriceUsdPerToken, 0);
});

test("any recorded spend or missing evidence fails closed", () => {
  for (const f of [
    "usage",
    "usage_daily",
    "usage_weekly",
    "usage_monthly",
    "byok_usage",
  ])
    assert.equal(build({ keyResponse: key({ [f]: 0.0001 }) }), null, f);
  for (const f of ["usage", "byok_usage"])
    assert.equal(
      build({ keyResponse: key({ [f]: undefined }) }),
      null,
      "missing " + f,
    );
  assert.equal(build({ keyResponse: null }), null);
  assert.equal(build({ keyResponse: { data: "x" } }), null);
});

test("blocking budget, exhausted key limit and bad quota fail closed", () => {
  assert.equal(
    build({ keyResponse: key({ effective_budget: { remaining_usd: 0 } }) }),
    null,
  );
  assert.equal(build({ keyResponse: key({ effective_budget: {} }) }), null);
  assert.equal(build({ keyResponse: key({ limit_remaining: 0 }) }), null);
  for (const q of [
    undefined,
    { used: 50, limit: 50, remaining: 0 },
    { used: 3, limit: 50, remaining: "47" },
    { used: 3, limit: 50, remaining: -1 },
    { used: 40, limit: 50, remaining: 47 },
    { used: 1.5, limit: 50, remaining: 48 },
  ])
    assert.equal(
      build({ keyResponse: key({ free_model_daily_requests: q }) }),
      null,
      JSON.stringify(q),
    );
  assert.deepEqual(evaluateAccountEvidence(key({ usage: 1 })).reasons, [
    "SPEND_NOT_ZERO:usage",
  ]);
});

test("only exact :free IDs with published zero prices count as free models", () => {
  assert.equal(isVerifiedFreeModel(model()), true);
  assert.equal(
    isVerifiedFreeModel(
      model("meta/llama-x:free", { prompt: "0.0", completion: "0.00" }),
    ),
    true,
  );
  for (const bad of [
    model("meta/llama-x"),
    model("meta/llama-x:free:extra"),
    model("llama-x:free"),
    model("meta/llama-x:FREE"),
    model("meta/llama-x:free", { prompt: "0", completion: "0.000001" }),
    model("meta/llama-x:free", { prompt: 0, completion: 0 }),
    model("meta/llama-x:free", { prompt: "-0", completion: "0" }),
    { id: "meta/llama-x:free", pricing: undefined },
    { id: "meta/llama-x:free" },
    null,
  ])
    assert.equal(isVerifiedFreeModel(bad), false, JSON.stringify(bad));
});

test("route binding must be trusted, same chain, paid-fallback-free and all-free", () => {
  assert.equal(build({ routeBinding: null }), null);
  assert.equal(build({ routeBinding: binding({ chain: "auto:other" }) }), null);
  assert.equal(build({ routeBinding: binding({ verified: false }) }), null);
  assert.equal(
    build({ routeBinding: binding({ noPaidFallback: undefined }) }),
    null,
  );
  assert.equal(build({ routeBinding: binding({ models: [] }) }), null);
  assert.equal(
    build({ routeBinding: binding({ models: [model(), model("a/b")] }) }),
    null,
  );
  assert.equal(build({ chain: "gpt-4" }), null);
  assert.equal(build({ observedAtEpochMs: "now" }), null);
});

test("a built proof satisfies the FreeLLMAPI admission gate, and nothing else does", async () => {
  const mk = (verifyZeroCostChain) =>
    createFreeLlmApiClient({
      apiKey: "k".repeat(32),
      approvedFreeChains: ["auto:code"],
      now: () => NOW + 1000,
      request: async () => ({ data: [{ id: "auto:code" }] }),
      verifyZeroCostChain,
    });
  const ok = mk(({ chain }) =>
    buildZeroCostProof({
      chain,
      observedAtEpochMs: NOW,
      keyResponse: key(),
      routeBinding: binding(),
    }),
  );
  assert.deepEqual(await ok.checkZeroCostChain({ chain: "auto:code" }), {
    admitted: true,
    chain: "auto:code",
  });
  const spent = mk(({ chain }) =>
    buildZeroCostProof({
      chain,
      observedAtEpochMs: NOW,
      keyResponse: key({ usage: 1 }),
      routeBinding: binding(),
    }),
  );
  await assert.rejects(
    () => spent.checkZeroCostChain({ chain: "auto:code" }),
    /FREELLMAPI_ZERO_COST_NOT_ATTESTED/,
  );
});

test("the module is pure and not imported by any source file", () => {
  const text = fs.readFileSync("src/openrouter-free-evidence.js", "utf8");
  assert.ok(
    !/\b(fetch|http|https|node:net|process\.env|child_process|readFile)\b/.test(
      text.replace(/\/\/.*$/gm, ""),
    ),
  );
  const importers = fs
    .readdirSync("src")
    .filter((f) => f.endsWith(".js") && f !== "openrouter-free-evidence.js")
    .filter((f) =>
      /openrouter-free-evidence/.test(
        fs.readFileSync(path.join("src", f), "utf8"),
      ),
    );
  assert.deepEqual(importers, []);
});
