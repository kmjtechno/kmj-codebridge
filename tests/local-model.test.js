import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createLocalModelClient } from "../src/local-model.js";
import {
  createDispatcher,
  definitions,
  FAST_READ_TOOLS,
} from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function mockLocalRuntime(t, responder) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk.toString("utf8");
    const payload = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: req.url, payload });
    const [status, value] = await responder(req.url, payload);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, requests };
}

test("unavailable local model never triggers a cloud connection or paid fallthrough", async () => {
  const client = createLocalModelClient({ port: 1 });
  const result = await client.status();
  assert.equal(result.available, false);
  assert.equal(result.cloudFallback, false);
  await assert.rejects(
    client.generate({ model: "qwen2.5:1.5b", prompt: "hello" }),
    /LOCAL_MODEL_NOT_RUNNING/,
  );
});

test("on-demand inference requires a local installed model and unloads it", async (t) => {
  const { port, requests } = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "tiny:1b" }] }];
    return [200, { done: true, response: "local result", eval_count: 26 }];
  });
  const client = createLocalModelClient({ port });
  assert.deepEqual((await client.status()).models, ["tiny:1b"]);
  const response = await client.generate({
    model: "tiny:1b",
    prompt: "print a local-only summary",
    maxTokens: 64,
  });
  assert.equal(response.response, "local result");
  assert.equal(response.paidInference, false);
  assert.equal(response.outputIsUntrusted, true);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/api/tags", "/api/tags", "/api/generate"],
  );
  assert.equal(requests[2].payload.keep_alive, 0);
  assert.equal(requests[2].payload.stream, false);
  assert.equal(requests[2].payload.options.num_predict, 64);
  assert.equal(requests[2].payload.prompt, "print a local-only summary");
});

test("rejects missing models, oversized prompts and fake responses", async (t) => {
  const { port, requests } = await mockLocalRuntime(t, async () => [
    200,
    { models: [{ name: "available:1b" }] },
  ]);
  const client = createLocalModelClient({ port });
  await assert.rejects(
    client.generate({ model: "missing:1b", prompt: "x" }),
    /LOCAL_MODEL_NOT_INSTALLED/,
  );
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/api/tags"],
  );
  await assert.rejects(
    client.generate({ model: "available:1b", prompt: "x".repeat(4097) }),
    /LOCAL_MODEL_REQUEST_INVALID/,
  );
});

test("explicit local processing approval and read/execute scopes are enforced", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-local-model-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot);
  const runner = new JobRunner(path.join(root, "jobs"));
  t.after(async () => runner.close());
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
  );
  const scope = { device: "device1", project: "p1" };
  assert.equal(definitions.local_model_generate.access, "execute");
  assert.ok(FAST_READ_TOOLS.includes("local_model_status"));
  await assert.rejects(
    dispatch(
      "local_model_generate",
      {
        ...scope,
        model: "tiny:1b",
        prompt: "hello",
      },
      ["execute"],
    ),
    /invalid_type|invalid_literal|invalid_union|Invalid literal value/i,
  );
  await assert.rejects(
    dispatch(
      "local_model_generate",
      {
        ...scope,
        model: "tiny:1b",
        prompt: "hello",
        localProcessingApproved: true,
      },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("local_model_status", scope, ["execute"]),
    /ACCESS_DENIED/,
  );
  const status = await dispatch("local_model_status", scope, ["read"]);
  assert.equal(status.project, "p1");
  assert.equal(status.cloudFallback, false);
});
