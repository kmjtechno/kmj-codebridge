import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher, definitions } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

test("curated skill recommendations are scoped read-only and legacy packs survive", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-skill-fabric-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const dispatch = createDispatcher(
    { id: "d1", stateDir: path.join(root, "state"), projects: [{ id: "p1", root: project, writable: false, gates: {}, commands: {} }] },
    { maxConcurrent: 1 },
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
  );
  const response = await dispatch("skill_recommendations", {
    device: "d1", project: "p1", objective: "Fix Laravel migrations and PHP queues",
  }, ["read"]);
  assert.ok(response.fabricSkills.some((s) => s.id === "laravel-php-engineering"));
  assert.ok(response.skills.some((s) => s.id === "tdd"));
  assert.equal(response.fabricSkills[0].inference, "FREELLMAPI_VERIFIED_FREE_CLOUD_ONLY");
});

test("skill-backed inference uses only verified FreeLLMAPI and preserves permission gates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-skill-generate-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const runner = new JobRunner(path.join(root, "jobs"));
  t.after(async () => { await runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const requests = [];
  const factory = () => createFreeLlmApiClient({
    apiKey: "freellma-test-key-0001",
    approvedFreeChains: ["auto:code"],
    verifyZeroCostChain: ({ chain, observedAtEpochMs }) => ({
      source: "authenticated_provider_billing_and_route_binding",
      chain, routeBindingVerified: true, accountNoChargeVerified: true,
      noPaidFallback: true, inputPriceUsdPerToken: 0, outputPriceUsdPerToken: 0,
      requestsRemaining: 3, observedAtEpochMs, expiresAtEpochMs: observedAtEpochMs + 30000,
    }),
    request: async (r) => {
      if (r.path === "/v1/models") return { data: [{ id: "auto:code" }] };
      requests.push(r);
      return { choices: [{ message: { content: "review draft only" }, finish_reason: "stop" }] };
    },
  });
  const dispatch = createDispatcher(
    { id: "d1", stateDir: path.join(root, "state"), projects: [{ id: "p1", root: project, writable: true, gates: {}, commands: {} }] },
    runner,
    () => ({ features: ["read", "execute"], limits: { concurrent_jobs: 1 } }),
    null, null, null, undefined, null, null, factory,
  );
  const scope = { device: "d1", project: "p1" };
  assert.ok(definitions.freellmapi_generate.input.skillId);
  const args = {
    ...scope, skillId: "rust-concurrency-ffi", prompt: "Review ownership",
    localProcessingApproved: true, upstreamCloudApproved: true,
  };
  await assert.rejects(dispatch("freellmapi_generate", args, ["read"]), /ACCESS_DENIED/);
  await assert.rejects(dispatch("freellmapi_generate", { ...args, upstreamCloudApproved: undefined }, ["execute"]));
  await assert.rejects(dispatch("freellmapi_generate", { ...args, skillId: "unknown-skill" }, ["execute"]), /SKILL_FABRIC_UNKNOWN_SKILL/);
  assert.equal(requests.length, 0);
  const result = await dispatch("freellmapi_generate", args, ["execute"]);
  assert.equal(result.skillFabric.id, "rust-concurrency-ffi");
  assert.equal(result.skillFabric.route, "FREELLMAPI_ONLY");
  assert.equal(result.paidInference, null);
  assert.equal(result.response, "review draft only");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, "auto:code");
  assert.ok(requests[0].body.messages[0].content.includes("Review ownership"));
  assert.ok(requests[0].body.messages[0].content.includes("Rust"));
  assert.equal(result.writesApplied, false);
});
