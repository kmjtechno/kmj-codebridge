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
