import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";
import {
  localModelReceipt,
  normalizeModelReceipt,
  unknownModelReceipt,
} from "../src/model-attribution.js";

test("the exact model-use receipt identifies CodeBridge's actual local operation, not the host chat", () => {
  const receipt = localModelReceipt("qwen2.5-coder:7b", "local_model_generate");
  assert.equal(receipt.provider, "local-ollama");
  assert.equal(receipt.model, "qwen2.5-coder:7b");
  assert.equal(receipt.execution, "verified_local_generation");
  assert.equal(receipt.scope, "codebridge_invocation");
  assert.equal(receipt.hostChatModel, "not_observable_by_codebridge");
  assert.equal(receipt.paidInference, false);
  assert.equal(receipt.cloudFallback, false);
  assert.deepEqual(normalizeModelReceipt(receipt), receipt);
  assert.equal(JSON.stringify(receipt).includes("prompt"), false);
});

test("legacy and unobserved responses never inherit the caller's requested model", () => {
  const unknown = unknownModelReceipt();
  assert.equal(unknown.model, null);
  assert.equal(unknown.provider, null);
  assert.equal(unknown.execution, "not_verified");
  assert.equal(unknown.hostChatModel, "not_observable_by_codebridge");
  assert.equal(normalizeModelReceipt(undefined), null);
});

test("untrusted metadata cannot smuggle keys, credentials or fabricated cloud providers", () => {
  for (const raw of [
    localModelReceipt("qwen3:4b", "local_model_generate"),
    {
      ...localModelReceipt("qwen3:4b", "local_model_generate"),
      apiKey: "secret",
    },
    {
      ...localModelReceipt("qwen3:4b", "local_model_generate"),
      paidInference: true,
    },
    {
      ...localModelReceipt("qwen3:4b", "local_model_generate"),
      provider: "openrouter",
    },
    {
      ...localModelReceipt("qwen3:4b", "local_model_generate"),
      model: undefined,
    },
    {
      ...localModelReceipt("qwen3:4b", "local_model_generate"),
      model: { toString: () => "qwen3:4b" },
    },
    {
      ...localModelReceipt("qwen3:4b", "local_model_generate"),
      hostChatModel: "GPT-6",
    },
  ].slice(1)) {
    assert.throws(
      () => normalizeModelReceipt(raw),
      /INVALID_MODEL_ATTRIBUTION/,
    );
  }
  assert.throws(
    () => localModelReceipt("Bearer secret value", "local_model_generate"),
    /INVALID_MODEL_ATTRIBUTION/,
  );
  assert.throws(
    () => localModelReceipt("qwen3:4b", "unknown-route"),
    /INVALID_MODEL_ATTRIBUTION/,
  );
});

test("connection doctor shows only observed project-scoped CodeBridge usage", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-model-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = ["p1", "p2"].map((id) => {
    const root = path.join(dir, id);
    fs.mkdirSync(root);
    return { id, root, writable: true, gates: {}, commands: {} };
  });
  const runner = new JobRunner(path.join(dir, "jobs"));
  t.after(async () => runner.close());
  let calls = 0;
  const dispatch = createDispatcher(
    { id: "device1", stateDir: path.join(dir, "state"), projects },
    runner,
    () => ({ features: ["read", "execute"], limits: { concurrent_jobs: 1 } }),
    null,
    null,
    null,
    () => ({
      async generate({ model }) {
        calls++;
        return {
          provider: "local-ollama",
          model,
          response: "safe",
          paidInference: false,
        };
      },
    }),
  );
  const scope = { device: "device1", project: "p1" };
  const before = await dispatch("connection_doctor", scope, ["read"]);
  assert.equal(before.modelUsageStatus.lastVerifiedInvocation, null);
  assert.equal(
    before.modelUsageStatus.originalChatHostModel,
    "not_observable_by_codebridge",
  );

  await assert.rejects(
    dispatch(
      "local_model_generate",
      {
        ...scope,
        model: "qwen3:4b",
        prompt: "hello",
        localProcessingApproved: true,
      },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
  assert.equal(
    (await dispatch("connection_doctor", scope, ["read"])).modelUsageStatus
      .lastVerifiedInvocation,
    null,
  );
  const generated = await dispatch(
    "local_model_generate",
    {
      ...scope,
      model: "qwen3:4b",
      prompt: "hello",
      localProcessingApproved: true,
    },
    ["execute"],
  );
  assert.equal(generated.modelUsage.model, "qwen3:4b");
  assert.equal(generated.modelUsage.execution, "verified_local_generation");
  assert.equal(calls, 1);
  const doctor = await dispatch("connection_doctor", scope, ["read"]);
  assert.equal(
    doctor.modelUsageStatus.lastVerifiedInvocation.model,
    "qwen3:4b",
  );
  assert.match(
    doctor.modelUsageStatus.lastVerifiedInvocation.observedAt,
    /^\d{4}-\d{2}-\d{2}T/,
  );
  assert.equal(
    doctor.modelUsageStatus.scope,
    "device_project_current_agent_process",
  );
  const other = await dispatch(
    "connection_doctor",
    { ...scope, project: "p2" },
    ["read"],
  );
  assert.equal(other.modelUsageStatus.lastVerifiedInvocation, null);
});
