import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { createLlamafileLocalBackend } from "../src/llamafile-backend.js";

async function serverFor(t, handler) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    hits.push({ method: req.method, path: req.url });
    await handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, hits };
}

function json(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const catalog = { data: [{ id: "Qwen3.8-Flash-Yamz" }] };

test("disabled by default; does not contact local server or load models", async (t) => {
  const { port, hits } = await serverFor(t, (_req, res) => json(res, catalog));
  const backend = createLlamafileLocalBackend({ port });
  const status = await backend.status();
  assert.equal(status.enabled, false);
  assert.equal(status.modelExecution, "NOT_EXECUTED");
  await assert.rejects(
    backend.generate({
      model: "Qwen3.8-Flash-Yamz",
      prompt: "hello",
      localProcessingApproved: true,
    }),
    /LLAMAFILE_NOT_ENABLED/,
  );
  assert.deepEqual(hits, []);
});

test("local discovery is bounded, read-only and never attests backend identity", async (t) => {
  const { port, hits } = await serverFor(t, (_req, res) => json(res, catalog));
  const backend = createLlamafileLocalBackend({ enabled: true, port });
  const status = await backend.status();
  assert.equal(status.available, true);
  assert.deepEqual(status.models, ["Qwen3.8-Flash-Yamz"]);
  assert.equal(status.backendIdentityVerified, false);
  assert.deepEqual(hits, [{ method: "GET", path: "/v1/models" }]);
});

test("opt-in inference requires explicit consent and exact installed model", async (t) => {
  const { port, hits } = await serverFor(t, (req, res) => {
    if (req.url === "/v1/models") return json(res, catalog);
    return json(res, {
      model: "Qwen3.8-Flash-Yamz",
      choices: [{ message: { content: "Generated draft only" } }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    });
  });
  const backend = createLlamafileLocalBackend({ enabled: true, port });
  const input = { model: "Qwen3.8-Flash-Yamz", prompt: "Write a draft" };
  await assert.rejects(backend.generate(input), /LLAMAFILE_APPROVAL_REQUIRED/);
  await assert.rejects(
    backend.generate({
      ...input,
      model: "other-model",
      localProcessingApproved: true,
    }),
    /LLAMAFILE_MODEL_NOT_INSTALLED/,
  );
  const response = await backend.generate({
    ...input,
    localProcessingApproved: true,
  });
  assert.equal(response.output, "Generated draft only");
  assert.equal(response.promptTokens, 8);
  assert.equal(response.modelExecution, "LOCAL_BACKEND_RESPONDED");
  assert.equal(response.billingVerified, false);
  assert.equal(response.backendIdentityVerified, false);
  assert.equal(response.cloudFallbackByAdapter, false);
  assert.equal(response.toolCallsExecuted, false);
  assert.deepEqual(hits, [
    { method: "GET", path: "/v1/models" },
    { method: "GET", path: "/v1/models" },
    { method: "POST", path: "/v1/chat/completions" },
  ]);
});

test("rejects unsafe port, parameters and payload sizes without network", async (t) => {
  assert.throws(
    () => createLlamafileLocalBackend({ enabled: true, port: -1 }),
    /LLAMAFILE_CONFIG_INVALID/,
  );
  assert.throws(
    () => createLlamafileLocalBackend({ enabled: "yes" }),
    /LLAMAFILE_CONFIG_INVALID/,
  );
  const { port, hits } = await serverFor(t, (_req, res) => json(res, catalog));
  const backend = createLlamafileLocalBackend({ enabled: true, port });
  for (const invalid of [
    { model: "../secret", prompt: "hello" },
    { model: "Qwen3.8-Flash-Yamz", prompt: "x".repeat(4097) },
    { model: "Qwen3.8-Flash-Yamz", prompt: "hello", maxTokens: 999 },
    { model: "Qwen3.8-Flash-Yamz", prompt: "hello", timeoutSeconds: 0 },
  ]) {
    await assert.rejects(
      backend.generate({ ...invalid, localProcessingApproved: true }),
      /LLAMAFILE_REQUEST_INVALID/,
    );
  }
  assert.deepEqual(hits, []);
});

test("refuses redirects and malformed/untrusted catalog instead of forwarding", async (t) => {
  const { port } = await serverFor(t, (_req, res) => {
    res.writeHead(302, { location: "https://external.example/v1/models" });
    res.end();
  });
  const backend = createLlamafileLocalBackend({ enabled: true, port });
  assert.equal((await backend.status()).available, false);

  const { port: badPort } = await serverFor(t, (_req, res) =>
    json(res, { data: [{ id: "../secret" }] }),
  );
  const bad = createLlamafileLocalBackend({ enabled: true, port: badPort });
  assert.equal((await bad.status()).available, false);
});

test("unverified generation or tool-only response fails closed", async (t) => {
  const { port } = await serverFor(t, (req, res) => {
    if (req.url === "/v1/models") return json(res, catalog);
    return json(res, {
      model: "wrong-model",
      choices: [{ message: { tool_calls: [{ function: { name: "rm" } }] } }],
    });
  });
  const backend = createLlamafileLocalBackend({ enabled: true, port });
  await assert.rejects(
    backend.generate({
      model: "Qwen3.8-Flash-Yamz",
      prompt: "draft",
      localProcessingApproved: true,
    }),
    /LLAMAFILE_GENERATION_INVALID/,
  );
});

test("a slow generation holds single-request lease and releases on completion", async (t) => {
  let resolveRequest;
  const gate = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  let signalEntered;
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const { port } = await serverFor(t, async (req, res) => {
    if (req.url === "/v1/models") return json(res, catalog);
    signalEntered();
    await gate;
    json(res, {
      model: "Qwen3.8-Flash-Yamz",
      choices: [{ message: { content: "done" } }],
    });
  });
  const backend = createLlamafileLocalBackend({ enabled: true, port });
  const args = {
    model: "Qwen3.8-Flash-Yamz",
    prompt: "draft",
    localProcessingApproved: true,
  };
  const first = backend.generate(args);
  await entered;
  await assert.rejects(backend.generate(args), /LLAMAFILE_BUSY/);
  resolveRequest();
  assert.equal((await first).output, "done");
});

test("local-only integration does not change production tools, start services or download weights", async () => {
  const backend = createLlamafileLocalBackend();
  const status = await backend.status();
  assert.equal(status.available, false);
  assert.equal(status.modelExecution, "NOT_EXECUTED");
  const source = fs.readFileSync("src/llamafile-backend.js", "utf8");
  assert.match(source, /hostname: "127\\.0\\.0\\.1"/);
  assert.doesNotMatch(source, /https:\/\/|spawn\(|exec\(|execFile\(|listen\(|download|fetch\(/i);
  assert.doesNotMatch(source, /openai\.com|api\.anthropic|ollama\.com/i);
});
