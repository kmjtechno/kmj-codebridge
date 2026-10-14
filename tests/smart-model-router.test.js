import assert from "node:assert/strict";
import { test } from "node:test";
import { planSmartModelRoute } from "../src/smart-model-router.js";

const local = {
  id: "qwen3:8b",
  provider: "ollama",
  kind: "local",
  free: true,
  privateCodeAllowed: true,
  contextWindow: 32768,
  capabilities: ["coding", "reasoning"],
  qualityScore: 65,
  reliabilityPct: 96,
  p95LatencyMs: 2800,
};
const cloud = {
  id: "groq-free",
  provider: "groq",
  kind: "cloud",
  free: true,
  privateCodeAllowed: false,
  contextWindow: 65536,
  capabilities: ["coding", "reasoning"],
  qualityScore: 90,
  reliabilityPct: 98,
  p95LatencyMs: 460,
  freeTierVerified: true,
  costPerMillionTokensUsd: 0,
  enabled: true,
  health: "ok",
  modelsDiscoveredAtMs: Date.now(),
};
const task = {
  capability: "coding",
  inputTokens: 1400,
  maxOutputTokens: 600,
  cloudApproved: true,
  privateCode: false,
};

test("local-first remains safe default even with faster free cloud", () => {
  const r = planSmartModelRoute({ models: [cloud, local], task: { ...task, strategy: "local-first" } });
  assert.equal(r.selected.modelId, local.id);
  assert.equal(r.fallbacks[0].modelId, cloud.id);
  assert.equal(r.modelExecution, "NOT_EXECUTED");
  assert.equal(r.promptOrConversationTransferred, false);
  assert.equal(r.hostChatModel, "NOT_OBSERVABLE_OR_SWITCHABLE_BY_CODEBRIDGE");
  assert.equal(
    r.metadataProvenance,
    "CALLER_SUPPLIED_NOT_VERIFIED_BY_CODEBRIDGE",
  );
});

test("explicitly approved free-cloud-first chooses fastest capable cloud", () => {
  const r = planSmartModelRoute({
    models: [local, cloud],
    task: { ...task, strategy: "approved-free-cloud-first" },
  });
  assert.equal(r.selected.modelId, cloud.id);
  assert.equal(r.fallbacks[0].modelId, local.id);
  assert.equal(r.selected.latencyEstimateMs, 460);
});

test("fastest and highest-quality optimize different independently measured hints", () => {
  const speedy = {
    ...local,
    id: "quick-local",
    p95LatencyMs: 250,
    qualityScore: 48,
  };
  const thoughtful = {
    ...local,
    id: "deep-local",
    p95LatencyMs: 115000,
    qualityScore: 99,
  };
  const fast = planSmartModelRoute({
    models: [thoughtful, speedy],
    task: { ...task, strategy: "fastest" },
  });
  const best = planSmartModelRoute({
    models: [thoughtful, speedy],
    task: { ...task, strategy: "highest-quality" },
  });
  assert.equal(fast.selected.modelId, speedy.id);
  assert.equal(best.selected.modelId, thoughtful.id);
});

test("never plans a cloud model without explicit zero-cost verified metadata", () => {
  for (const candidate of [
    { ...cloud, freeTierVerified: false },
    { ...cloud, costPerMillionTokensUsd: 1 },
    { ...cloud, costPerMillionTokensUsd: undefined },
    { ...cloud, free: false },
  ]) {
    const r = planSmartModelRoute({
      models: [candidate, local],
      task: { ...task, strategy: "approved-free-cloud-first" },
    });
    assert.equal(r.selected.modelId, local.id);
    assert.equal(r.eligibleCount, 1);
  }
});

test("unauthorized cloud or private-code nonapproved provider never enters plan", () => {
  const noCloud = planSmartModelRoute({
    models: [cloud, local],
    task: { ...task, cloudApproved: false, strategy: "fastest" },
  });
  assert.equal(noCloud.selected.modelId, local.id);
  const privateCode = planSmartModelRoute({
    models: [cloud, local],
    task: { ...task, privateCode: true, strategy: "fastest" },
  });
  assert.equal(privateCode.selected.modelId, local.id);
});

test("quota, backoff, full context and capability are respected", () => {
  const options = { models: [local, cloud], task };
  const state = {
    [cloud.id]: { remainingRequests: 0, cooldownUntil: Date.now() + 45000 },
  };
  let r = planSmartModelRoute({
    ...options,
    task: { ...task, strategy: "approved-free-cloud-first" },
    state,
  });
  assert.equal(r.selected.modelId, local.id);
  r = planSmartModelRoute({
    ...options,
    task: { ...task, inputTokens: 33000 },
  });
  assert.equal(r.selected.modelId, cloud.id);
  r = planSmartModelRoute({
    ...options,
    task: { ...task, inputTokens: 90000 },
  });
  assert.equal(r.selected, null);
  assert.equal(r.outcome, "NO_FREE_AUTHORIZED_CAPABLE_MODEL");
  r = planSmartModelRoute({
    ...options,
    task: { ...task, capability: "vision" },
  });
  assert.equal(r.selected, null);
});


test("the default route uses approved free cloud then offline local backup", () => {
  const r = planSmartModelRoute({ models: [cloud, local], task });
  assert.equal(r.strategy, "approved-free-cloud-first");
  assert.equal(r.selected.modelId, cloud.id);
  assert.equal(r.fallbacks[0].modelId, local.id);
});

test("real OpenRouter vendor/model:free identifiers are supported; paid variants blocked", () => {
  const openrouter = {
    ...cloud,
    id: "nvidia/nemotron-3-ultra-50b-a55b:free",
    provider: "openrouter",
    capabilities: ["reasoning"],
  };
  const result = planSmartModelRoute({
    models: [openrouter, local],
    task: { ...task, capability: "reasoning" },
  });
  assert.equal(result.selected.modelId, openrouter.id);
  const paidAlias = { ...openrouter, id: "nvidia/nemotron-3-ultra-50b-a55b" };
  const denied = planSmartModelRoute({
    models: [paidAlias, local],
    task: { ...task, capability: "reasoning" },
  });
  assert.equal(denied.selected.modelId, local.id);
});

test("no false healthy cloud selection on stale, absent or disabled discovery", () => {
  const now = Date.now();
  for (const bad of [
    { enabled: false },
    { health: "error" },
    { health: "unknown" },
    { modelsDiscoveredAtMs: now - 25 * 60 * 60 * 1000 },
    { modelsDiscoveredAtMs: now + 10000 },
    { modelsDiscoveredAtMs: undefined },
  ]) {
    const r = planSmartModelRoute({
      models: [{ ...cloud, ...bad }, local],
      task,
      nowMs: now,
    });
    assert.equal(r.selected.modelId, local.id);
    assert.equal(r.eligibleCount, 1);
  }
  const noLocal = planSmartModelRoute({
    models: [{ ...cloud, enabled: false }, { ...local, available: false }],
    task,
    nowMs: now,
  });
  assert.equal(noLocal.outcome, "NO_FREE_AUTHORIZED_CAPABLE_MODEL");
});

test("routing invalid configuration and timing metadata fails closed", () => {
  const params = { models: [local], task };
  for (const invalid of [
    { ...params, task: { ...task, inputTokens: -1 } },
    { ...params, task: { ...task, maxOutputTokens: 0 } },
    { ...params, task: { ...task, strategy: "paid-fallback" } },
    { ...params, models: [{ ...local, p95LatencyMs: -1 }] },
    { ...params, models: [{ ...local, reliabilityPct: 101 }] },
    { ...params, models: [{ ...local, qualityScore: NaN }] },
    { ...params, models: [local, local] },
  ])
    assert.throws(
      () => planSmartModelRoute(invalid),
      /SMART_MODEL_ROUTER_|MODEL_POLICY_/,
    );
});
