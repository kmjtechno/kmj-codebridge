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
  assert.equal(response.modelUnloadRequested, true);
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

test("multiple authorized loopback Ollama ports combine installed models and route exact model locally", async (t) => {
  const first = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "qwen2.5-coder:7b" }] }];
    return [200, { response: "coding result", done: true, eval_count: 12 }];
  });
  const second = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "qwen3:4b" }] }];
    return [200, { response: "reasoning result", done: true, eval_count: 16 }];
  });
  const client = createLocalModelClient({
    ports: [first.port, 1, second.port],
  });
  const available = await client.status();
  assert.equal(available.available, true);
  assert.deepEqual(available.models, ["qwen2.5-coder:7b", "qwen3:4b"]);
  const draft = await client.generate({
    model: "qwen3:4b",
    prompt: "plan the next test",
    maxTokens: 64,
  });
  assert.equal(draft.response, "reasoning result");
  assert.equal(draft.paidInference, false);
  assert.deepEqual(
    first.requests.map((x) => x.path).filter((x) => x === "/api/generate"),
    [],
  );
  assert.equal(
    second.requests.filter((x) => x.path === "/api/generate").length,
    1,
  );
  assert.equal(second.requests.at(-1).payload.keep_alive, 0);
  await assert.rejects(
    client.generate({ model: "not-installed:1b", prompt: "test" }),
    /LOCAL_MODEL_NOT_INSTALLED/,
  );
});

test("invalid local model port selections fail closed before network access", () => {
  for (const ports of [
    [],
    [0],
    [65536],
    [-1],
    [11434, 11434],
    [1, 2, 3, 4],
    ["11435"],
  ]) {
    assert.throws(
      () => createLocalModelClient({ ports }),
      /LOCAL_MODEL_INVALID_PORT/,
    );
  }
});

test("Qwen3 bounded local generation disables thinking without rewriting user prompts", async (t) => {
  const { port, requests } = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "qwen3:8b" }] }];
    return [200, { done: true, response: "hello", eval_count: 3 }];
  });
  const client = createLocalModelClient({ port });
  const reply = await client.generate({
    model: "qwen3:8b",
    prompt: "Say hello",
    maxTokens: 64,
  });
  assert.equal(reply.response, "hello");
  assert.equal(reply.paidInference, false);
  assert.equal(reply.cloudFallback, false);
  const generation = requests.find((r) => r.path === "/api/generate");
  assert.equal(generation.payload.think, false);
  assert.equal(generation.payload.prompt, "Say hello");
  assert.equal(generation.payload.options.num_predict, 64);
  assert.equal(generation.payload.keep_alive, 0);
});

test("non-Qwen3 models retain the previous API payload and no forced thinking switch", async (t) => {
  const { port, requests } = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "qwen2.5-coder:7b" }] }];
    return [200, { done: true, response: "safe patch draft" }];
  });
  const client = createLocalModelClient({ port });
  const reply = await client.generate({
    model: "qwen2.5-coder:7b",
    prompt: "Suggest one safe test",
  });
  assert.equal(reply.response, "safe patch draft");
  const generation = requests.find((r) => r.path === "/api/generate");
  assert.equal(Object.hasOwn(generation.payload, "think"), false);
  assert.equal(generation.payload.prompt, "Suggest one safe test");
});

test("thinking-only Ollama completion fails closed instead of claiming visible output", async (t) => {
  const { port } = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "qwen3:8b" }] }];
    return [
      200,
      {
        done: true,
        response: " \n ",
        thinking: "hidden reasoning",
        eval_count: 64,
      },
    ];
  });
  const client = createLocalModelClient({ port });
  await assert.rejects(
    client.generate({
      model: "qwen3:8b",
      prompt: "Return visible text",
      maxTokens: 64,
    }),
    /LOCAL_MODEL_NO_VISIBLE_OUTPUT/,
  );
  assert.equal((await client.status()).activeRequest, false);
  assert.equal((await client.status()).cloudFallback, false);
});

test("opt-in bounded warm retention avoids repeated model unload without cloud inference", async (t) => {
  const { port, requests } = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "qwen2.5-coder:7b" }] }];
    return [200, { done: true, response: "safe code", eval_count: 5 }];
  });
  const client = createLocalModelClient({ port, warmSeconds: 30 });
  const reply = await client.generate({
    model: "qwen2.5-coder:7b",
    prompt: "Suggest one safe patch",
    maxTokens: 48,
  });
  assert.equal(reply.response, "safe code");
  assert.equal(reply.modelUnloadRequested, false);
  assert.equal(reply.modelWarmSeconds, 30);
  assert.equal(reply.cloudFallback, false);
  assert.equal(reply.paidInference, false);
  const generation = requests.find((r) => r.path === "/api/generate");
  assert.equal(generation.payload.keep_alive, "30s");
  assert.equal(generation.payload.options.num_predict, 48);
});

test("warm retention is disabled by default and rejects invalid resource settings", () => {
  const client = createLocalModelClient({ port: 1 });
  assert.ok(client);
  for (const warmSeconds of [-1, 61, 1.5, NaN, "30", Infinity]) {
    assert.throws(
      () => createLocalModelClient({ port: 1, warmSeconds }),
      /LOCAL_MODEL_INVALID_WARM_SECONDS/,
    );
  }
});

test("Ollama timing metadata remains bounded, local-only and is not fabricated", async (t) => {
  const { port } = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "qwen3:4b" }] }];
    return [
      200,
      {
        done: true,
        response: "function add(a, b) { return a + b; }",
        total_duration: 2500000000,
        load_duration: 1300000000,
        prompt_eval_duration: 200000000,
        prompt_eval_count: 18,
        eval_duration: 1000000000,
        eval_count: 32,
      },
    ];
  });
  const client = createLocalModelClient({ port, warmSeconds: 30 });
  const value = await client.generate({
    model: "qwen3:4b",
    prompt: "Write add(a,b)",
    maxTokens: 64,
  });
  assert.deepEqual(value.timing, {
    totalMs: 2500,
    loadMs: 1300,
    promptMs: 200,
    generationMs: 1000,
    promptTokens: 18,
    generationTokens: 32,
    generationTokensPerSecond: 32,
  });
  assert.equal(value.paidInference, false);
  assert.equal(value.cloudFallback, false);
  assert.equal(value.modelWarmSeconds, 30);
});

test("missing or malicious Ollama timing counters never fabricate measured speed", async (t) => {
  const { port } = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "qwen2.5-coder:7b" }] }];
    return [
      200,
      {
        done: true,
        response: "local",
        total_duration: -1,
        load_duration: "999999999",
        eval_count: 42,
        eval_duration: 0,
      },
    ];
  });
  const client = createLocalModelClient({ port, warmSeconds: 0 });
  const reply = await client.generate({
    model: "qwen2.5-coder:7b",
    prompt: "Return local",
  });
  assert.deepEqual(reply.timing, {
    totalMs: null,
    loadMs: null,
    promptMs: null,
    generationMs: 0,
    promptTokens: null,
    generationTokens: 42,
    generationTokensPerSecond: null,
  });
  assert.equal(reply.modelUnloadRequested, true);
});

test("local warm-retention environment only accepts exact integer seconds", (t) => {
  const variable = "CODEBRIDGE_LOCAL_MODEL_WARM_SECONDS";
  const previous = process.env[variable];
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  for (const value of ["", " ", "30.0", "-1", "61", "1e1", "01 ", "abc"]) {
    process.env[variable] = value;
    assert.throws(
      () => createLocalModelClient({ port: 1 }),
      /LOCAL_MODEL_INVALID_WARM_SECONDS/,
    );
  }
  process.env[variable] = "30";
  assert.ok(createLocalModelClient({ port: 1 }));
  process.env[variable] = "0";
  assert.ok(createLocalModelClient({ port: 1 }));
});

test("hitTokenLimit reports a model stopped by the token budget, not a finished answer", async (t) => {
  const replies = {
    cap: { done: true, response: "cut off mid", eval_count: 32 },
    reason: {
      done: true,
      response: "also cut",
      eval_count: 7,
      done_reason: "length",
    },
    finished: {
      done: true,
      response: "complete",
      eval_count: 9,
      done_reason: "stop",
    },
    unmeasured: { done: true, response: "no counters" },
  };
  let next = "cap";
  const { port } = await mockLocalRuntime(t, async (endpoint) => {
    if (endpoint === "/api/tags")
      return [200, { models: [{ name: "tiny:1b" }] }];
    return [200, replies[next]];
  });
  const client = createLocalModelClient({ port });
  const run = async (key) => {
    next = key;
    return client.generate({
      model: "tiny:1b",
      prompt: "x",
      maxTokens: 32,
    });
  };
  assert.equal((await run("cap")).hitTokenLimit, true);
  assert.equal((await run("reason")).hitTokenLimit, true);
  assert.equal((await run("finished")).hitTokenLimit, false);
  // Missing counters are never guessed into a limit hit.
  assert.equal((await run("unmeasured")).hitTokenLimit, false);
  // `truncated` keeps its separate, character-slice meaning.
  assert.equal((await run("cap")).truncated, false);
});
