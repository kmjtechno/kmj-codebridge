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
import { agentSchema } from "../src/config.js";
import { modelRegistrySchema } from "../src/model-registry-schema.js";

const REG = [
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
    id: "cloud-free",
    provider: "cloud",
    kind: "cloud",
    free: true,
    privateCodeAllowed: false,
    contextWindow: 65536,
    capabilities: ["coding"],
  },
];

function make(t, registry, freeFactory) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-inv-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      modelRegistry: registry,
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
    null,
    null,
    null,
    undefined,
    null,
    null,
    freeFactory,
  );
}

test("model_inventory is read-only and lists the owner registry without overlay", async (t) => {
  assert.equal(definitions.model_inventory.access, "read");
  assert.ok(FAST_READ_TOOLS.includes("model_inventory"));
  const dispatch = make(t, REG, () => {
    throw new Error("router must not be touched without overlay");
  });
  const r = await dispatch("model_inventory", { device: "d1", project: "p1" }, [
    "read",
  ]);
  assert.equal(r.source, "OWNER_REGISTRY");
  assert.equal(r.configured, 2);
  assert.equal(r.liveOverlay, false);
  assert.equal(r.modelExecution, "NOT_EXECUTED");
  assert.equal(r.costProof, "NOT_PROVEN");
  assert.deepEqual(
    r.models.map((m) => m.id),
    ["qwen3:8b", "cloud-free"],
  );
});

test("model_inventory overlay demotes models the router does not report ready", async (t) => {
  const dispatch = make(t, REG, () => ({
    catalog: async () => ({
      data: [
        { id: "qwen3:8b", available: true, execution_status: "ready" },
        { id: "cloud-free", available: false, execution_status: "exhausted" },
      ],
    }),
  }));
  const r = await dispatch(
    "model_inventory",
    { device: "d1", project: "p1", liveRouterOverlay: true },
    ["read"],
  );
  assert.equal(r.liveOverlay, true);
  assert.deepEqual(r.demoted, ["cloud-free"]);
});

test("model_inventory with unreadable overlay fails and empty registry is empty", async (t) => {
  const bad = make(t, REG, () => ({
    catalog: async () => {
      throw new Error("ROUTER_DOWN");
    },
  }));
  await assert.rejects(
    bad(
      "model_inventory",
      { device: "d1", project: "p1", liveRouterOverlay: true },
      ["read"],
    ),
  );
  const empty = make(t, undefined, null);
  const r = await empty("model_inventory", { device: "d1", project: "p1" }, [
    "read",
  ]);
  assert.equal(r.configured, 0);
  assert.deepEqual(r.models, []);
});

test("model registry schema is strict and rejects duplicates and live fields", () => {
  assert.ok(modelRegistrySchema.safeParse(REG).success);
  assert.ok(!modelRegistrySchema.safeParse([REG[0], REG[0]]).success);
  assert.ok(
    !modelRegistrySchema.safeParse([{ ...REG[0], available: true }]).success,
  );
  assert.ok(
    !modelRegistrySchema.safeParse([{ ...REG[0], health: "ok" }]).success,
  );
  assert.ok("modelRegistry" in agentSchema.shape);
});
