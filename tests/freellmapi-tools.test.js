import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher, definitions } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";
import { AuditLedger } from "../src/audit.js";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";
import { forwardTimeoutMs } from "../src/gateway.js";

test("freellmapi tools enforce consent and scopes and route through the factory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-freellm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot);
  const runner = new JobRunner(path.join(root, "jobs"));
  const audit = new AuditLedger(path.join(root, "audit"));
  t.after(async () => runner.close());
  const seen = [];
  const factory = () =>
    createFreeLlmApiClient({
      apiKey: "freellma-test-key-0001",
      approvedFreeChains: ["auto:default"],
      request: async (r) => {
        if (r.path === "/v1/models") return { data: [{ id: "auto:default" }] };
        seen.push(r.body.model);
        return {
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        };
      },
    });
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir: path.join(root, "state"),
      projects: [
        {
          id: "p1",
          root: projectRoot,
          writable: true,
          gates: {},
          commands: {},
        },
      ],
    },
    runner,
    () => ({ features: ["read", "execute"], limits: { concurrent_jobs: 1 } }),
    null,
    null,
    audit,
    undefined,
    null,
    factory,
  );
  const scope = { device: "device1", project: "p1" };
  assert.equal(definitions.freellmapi_generate.access, "execute");
  assert.ok(definitions.freellmapi_generate.input.upstreamCloudApproved);
  assert.equal(definitions.freellmapi_status.access, "read");
  await assert.rejects(
    dispatch("freellmapi_generate", { ...scope, prompt: "x" }, ["execute"]),
    /invalid_literal|Invalid literal value|invalid_type/i,
  );
  await assert.rejects(
    dispatch(
      "freellmapi_generate",
      {
        ...scope,
        prompt: "x",
        localProcessingApproved: true,
        upstreamCloudApproved: true,
      },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
  const status = await dispatch("freellmapi_status", scope, ["read"]);
  assert.deepEqual(status.chains, ["auto:default"]);
  const marker = "PRIVATE_PROMPT_SENTINEL_20261015";
  const out = await dispatch(
    "freellmapi_generate",
    {
      ...scope,
      prompt: marker,
      task: "code",
      localProcessingApproved: true,
      upstreamCloudApproved: true,
    },
    ["execute"],
  );
  assert.equal(out.response, "hi");
  assert.equal(out.paidInference, null);
  assert.equal(out.billingVerified, false);
  assert.deepEqual(seen, ["auto:default"]);
  // Confirm actual persisted audit receipts do not contain supplied prompts.
  // JobRunner does not receive or record this adapter's inputs.
  const auditFile = fs.readFileSync(path.join(root, "audit", "p1.jsonl"), "utf8");
  assert.equal(auditFile.includes(marker), false);
  assert.equal(audit.tail("p1", 10).entries.length, 2);
  const jobStoreFiles = fs.readdirSync(path.join(root, "jobs"), {
    recursive: true,
  });
  for (const relative of jobStoreFiles) {
    const full = path.join(root, "jobs", relative);
    if (fs.statSync(full).isFile())
      assert.equal(fs.readFileSync(full, "utf8").includes(marker), false);
  }
  assert.equal(
    forwardTimeoutMs(15000, "freellmapi_generate", { timeoutSeconds: 45 }),
    60000,
  );
});
