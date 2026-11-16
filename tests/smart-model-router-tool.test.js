import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDispatcher,
  FAST_READ_TOOLS,
  definitions,
} from "../src/tools.js";

test("AI-chat model_route_plan is a genuine project-scoped, read-only MCP tool", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-router-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({
      features: ["read"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  assert.equal(definitions.model_route_plan.access, "read");
  assert.ok(FAST_READ_TOOLS.includes("model_route_plan"));
  const r = await dispatch(
    "model_route_plan",
    {
      device: "d1",
      project: "p1",
      models: [
        {
          id: "qwen3:8b",
          provider: "ollama",
          kind: "local",
          free: true,
          privateCodeAllowed: true,
          contextWindow: 32768,
          capabilities: ["coding"],
          p95LatencyMs: 1500,
          qualityScore: 80,
        },
        {
          id: "cloud-free",
          provider: "cloud",
          kind: "cloud",
          free: true,
          privateCodeAllowed: false,
          contextWindow: 65536,
          capabilities: ["coding"],
          freeTierVerified: true,
          costPerMillionTokensUsd: 0,
          p95LatencyMs: 200,
        },
      ],
      task: {
        capability: "coding",
        inputTokens: 500,
        maxOutputTokens: 300,
        strategy: "fastest",
        cloudApproved: false,
        privateCode: true,
      },
    },
    ["read"],
  );
  assert.equal(r.selected.modelId, "qwen3:8b");
  assert.equal(r.modelExecution, "NOT_EXECUTED");
  assert.equal(r.hostChatModel, "NOT_OBSERVABLE_OR_SWITCHABLE_BY_CODEBRIDGE");
});

test("MCP model_route_plan exposes cloud-only and cannot fall back to local", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cloud-only-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({
      features: ["read"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  const models = [
    {
      id: "qwen3:8b",
      provider: "ollama",
      kind: "local",
      free: true,
      privateCodeAllowed: true,
      contextWindow: 32768,
      capabilities: ["coding"],
    },
    {
      id: "vendor/verified-cloud:free",
      provider: "openrouter",
      kind: "cloud",
      free: true,
      privateCodeAllowed: false,
      contextWindow: 65536,
      capabilities: ["coding"],
      enabled: true,
      health: "ok",
      modelsDiscoveredAtMs: Date.now(),
      freeTierVerified: true,
      costPerMillionTokensUsd: 0,
    },
  ];
  const input = {
    device: "d1",
    project: "p1",
    models,
    task: {
      capability: "coding",
      inputTokens: 1000,
      maxOutputTokens: 200,
      strategy: "verified-free-cloud-only",
      cloudApproved: true,
      privateCode: false,
    },
  };
  const r = await dispatch("model_route_plan", input, ["read"]);
  assert.equal(r.selected.modelId, "vendor/verified-cloud:free");
  assert.equal(r.localFallbackAllowed, false);
  assert.deepEqual(r.fallbacks, []);
  assert.equal(r.modelExecution, "NOT_EXECUTED");
  const blocked = await dispatch(
    "model_route_plan",
    {
      ...input,
      models: [models[0], { ...models[1], freeTierVerified: false }],
    },
    ["read"],
  );
  assert.equal(blocked.selected, null);
  assert.equal(blocked.localFallbackAllowed, false);
  assert.equal(blocked.promptOrConversationTransferred, false);
});

test("MCP model_route_plan accepts declared limits and rotates away from a nearly exhausted free model", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-headroom-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
  );
  const nowMs = Date.now();
  const cloud = (id, provider, extra = {}) => ({
    id,
    provider,
    kind: "cloud",
    free: true,
    privateCodeAllowed: true,
    contextWindow: 65536,
    capabilities: ["coding"],
    enabled: true,
    health: "ok",
    modelsDiscoveredAtMs: nowMs - 1000,
    freeTierVerified: true,
    costPerMillionTokensUsd: 0,
    ...extra,
  });
  const models = [
    cloud("vendor/m:free", "openrouter", { limits: { perDay: 50 } }),
    cloud("llama-x", "groq"),
  ];
  const task = {
    capability: "coding",
    inputTokens: 100,
    maxOutputTokens: 100,
    strategy: "verified-free-cloud-only",
    cloudApproved: true,
    privateCode: true,
    currentModelId: "vendor/m:free",
  };
  const args = { device: "d1", project: "p1", models, task };
  const fresh = await dispatch("model_route_plan", args, ["read"]);
  assert.equal(fresh.rotateAdvised, false);
  const near = await dispatch(
    "model_route_plan",
    {
      ...args,
      quotaState: {
        "vendor/m:free": {
          dayKey: new Date(nowMs).toISOString().slice(0, 10),
          dayCount: 46,
        },
      },
    },
    ["read"],
  );
  assert.equal(near.selected.modelId, "llama-x");
  assert.equal(near.rotateAdvised, true);
  assert.equal(near.localFallbackAllowed, false);
  await assert.rejects(
    () =>
      dispatch(
        "model_route_plan",
        {
          ...args,
          models: [{ ...models[0], limits: { perHour: 1 } }, models[1]],
        },
        ["read"],
      ),
    /./,
  );
});
