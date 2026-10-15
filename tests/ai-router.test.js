import assert from "node:assert/strict";
import { test } from "node:test";
import { routeAIRequest } from "../src/ai-router.js";

const NOW = 1_800_000_000_000;
const local = {
  id: "qwen3:8b",
  provider: "ollama",
  kind: "local",
  free: true,
  privateCodeAllowed: true,
  contextWindow: 32768,
  capabilities: ["coding"],
  available: true,
};
const cloud = {
  id: "openrouter/qwen:free",
  provider: "openrouter",
  kind: "cloud",
  free: true,
  privateCodeAllowed: false,
  contextWindow: 32768,
  capabilities: ["coding"],
  freeTierVerified: true,
  costPerMillionTokensUsd: 0,
  enabled: true,
  health: "ok",
  modelsDiscoveredAtMs: NOW,
};
const paid = {
  ...cloud,
  id: "openrouter/paid",
  free: false,
  costPerMillionTokensUsd: 1,
};
const task = { inputTokens: 700, maxOutputTokens: 256 };

test("legacy router is a working ES module and defaults to local-first privacy", () => {
  const output = routeAIRequest({
    models: [cloud, paid, local],
    task,
    nowMs: NOW,
  });
  assert.equal(output.selected.modelId, local.id);
  assert.equal(output.outcome, "ROUTE_PLAN_READY");
  assert.equal(output.promptOrConversationTransferred, false);
  assert.equal(output.modelExecution, "NOT_EXECUTED");
  assert.equal(output.cloudAllowedForPlanning, false);
  assert.equal(output.privateCode, true);
  assert.equal(output.fallbacks.length, 0);
});

test("long prompts never silently authorize paid or cloud inference", () => {
  const output = routeAIRequest({
    models: [cloud, paid],
    task: { ...task, inputTokens: 12000 },
    nowMs: NOW,
  });
  assert.equal(output.selected, null);
  assert.equal(output.outcome, "NO_FREE_AUTHORIZED_CAPABLE_MODEL");
  assert.equal(output.promptOrConversationTransferred, false);
});

test("explicit cloud consent still rejects paid models and private-code transfer", () => {
  const privateOutput = routeAIRequest({
    models: [cloud, paid],
    task: { ...task, cloudApproved: true },
    nowMs: NOW,
  });
  assert.equal(privateOutput.selected, null);

  const publicOutput = routeAIRequest({
    models: [paid, cloud],
    task: { ...task, cloudApproved: true, privateCode: false },
    nowMs: NOW,
  });
  assert.equal(publicOutput.selected.modelId, cloud.id);
  assert.deepEqual(publicOutput.fallbacks, []);
  assert.equal(publicOutput.modelExecution, "NOT_EXECUTED");
  assert.equal(publicOutput.pricingGuarantee, "HOST_MUST_VERIFY_BEFORE_REAL_PROVIDER_CALL");
});

test("no prompt-length-string fallback or untrusted gateway endpoint", () => {
  assert.throws(
    () => routeAIRequest({ models: [local], task: "A".repeat(1000), nowMs: NOW }),
    /AI_ROUTER_INVALID_TASK/,
  );
  assert.throws(() => routeAIRequest(), /AI_ROUTER_INVALID_TASK/);
});

test("stale cloud price metadata never makes a paid fallback eligible", () => {
  const output = routeAIRequest({
    models: [cloud],
    task: { ...task, cloudApproved: true, privateCode: false },
    nowMs: NOW + 86_400_000,
  });
  assert.equal(output.selected, null);
});
