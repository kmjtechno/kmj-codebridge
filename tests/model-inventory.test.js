import test from "node:test";
import assert from "node:assert/strict";
import { buildRoutingInventory } from "../src/model-inventory.js";
import { planSmartModelRoute } from "../src/smart-model-router.js";

const NOW = 1_800_000_000_000;
const base = (id, provider, extra = {}) => ({
  id,
  provider,
  kind: "cloud",
  free: true,
  privateCodeAllowed: false,
  enabled: true,
  health: "ok",
  modelsDiscoveredAtMs: NOW - 1000,
  contextWindow: 128000,
  capabilities: ["coding"],
  qualityScore: 80,
  reliabilityPct: 95,
  p95LatencyMs: 2000,
  freeTierVerified: true,
  costPerMillionTokensUsd: 0,
  ...extra,
});
const registry = [
  base("vendor/model-a:free", "openrouter"),
  base("llama-x", "groq"),
  base("gemini-y", "gemini", { qualityScore: 90 }),
];
const row = (id, status, extra = {}) => ({
  id,
  available: status === "ready",
  execution_status: status,
  context_window: 64000,
  ...extra,
});

test("catalog rows outside the owner registry are never admitted", () => {
  const out = buildRoutingInventory({
    ownerRegistry: registry,
    catalog: { data: [row("rogue-paid", "ready"), row("llama-x", "ready")] },
    nowMs: NOW,
  });
  assert.deepEqual(
    out.models.map((m) => m.id),
    registry.map((m) => m.id),
  );
});

test("only positively ready models stay routable; exhausted and no-key are demoted", () => {
  const out = buildRoutingInventory({
    ownerRegistry: registry,
    catalog: {
      data: [row("vendor/model-a:free", "ready"), row("llama-x", "exhausted")],
    },
    nowMs: NOW,
  });
  const by = Object.fromEntries(out.models.map((m) => [m.id, m]));
  assert.equal(by["vendor/model-a:free"].health, "ok");
  assert.equal(by["vendor/model-a:free"].contextWindow, 64000);
  assert.equal(by["llama-x"].health, "error");
  assert.equal(by["gemini-y"].health, "error"); // missing from catalog
});

test("planner routes across providers and skips exhausted ones", () => {
  const { models } = buildRoutingInventory({
    ownerRegistry: registry,
    catalog: {
      data: [
        row("vendor/model-a:free", "ready"),
        row("llama-x", "ready"),
        row("gemini-y", "exhausted"),
      ],
    },
    nowMs: NOW,
  });
  const plan = planSmartModelRoute({
    models,
    task: {
      capability: "coding",
      strategy: "verified-free-cloud-only",
      cloudApproved: true,
      privateCode: false,
      inputTokens: 1000,
      maxOutputTokens: 500,
    },
    state: {},
    nowMs: NOW,
  });
  assert.equal(plan.outcome, "ROUTE_PLAN_READY");
  const routed = [plan.selected, ...plan.fallbacks].map((o) => o.modelId);
  assert.deepEqual(routed.sort(), ["llama-x", "vendor/model-a:free"]);
});

test("bad registry entries and duplicates are rejected, not guessed", () => {
  const out = buildRoutingInventory({
    ownerRegistry: [
      ...registry,
      { id: "llama-x", provider: "groq", contextWindow: 1 },
      { id: "bad id!", provider: "x", contextWindow: 10 },
      null,
    ],
    nowMs: NOW,
  });
  assert.equal(out.models.length, 3);
  assert.equal(out.rejected.length, 3);
  assert.equal(out.liveOverlay, false);
});

test("input errors fail closed", () => {
  assert.throws(() => buildRoutingInventory({ ownerRegistry: [], nowMs: -1 }));
  assert.throws(() =>
    buildRoutingInventory({ ownerRegistry: "x", nowMs: NOW }),
  );
});
