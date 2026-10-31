import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createLlamaCppLocalModelClient,
  useP520LlamaCpp,
} from "../src/llamacpp-local.js";
import {
  localModelReceipt,
  normalizeModelReceipt,
} from "../src/model-attribution.js";

const MODEL = "Qwen3.5-9B-Q4_K_M.gguf";

async function serverFor(t, handle) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    sockets.add(req.socket);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const data = body ? JSON.parse(body) : null;
    requests.push({ path: req.url, method: req.method, data });
    const [status, reply] = await handle(req.url, data);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, requests, sockets };
}

function responder(endpoint) {
  if (endpoint === "/health") return [200, { status: "ok" }];
  if (endpoint === "/v1/models") return [200, { data: [{ id: MODEL }] }];
  return [
    200,
    {
      content: "def is_prime(n): return n > 1",
      tokens_predicted: 20,
      tokens_evaluated: 9,
      stopped_eos: true,
      timings: { prompt_ms: 20, predicted_ms: 2000, predicted_per_second: 10 },
    },
  ];
}

test("P520 llama.cpp mode requires exact owner flag, Windows, device and hostname", () => {
  const valid = {
    enabled: "1",
    platform: "win32",
    hostname: "DESKTOP-5FVJMET",
    deviceId: "kmj-kmj-codebridge-desktop-5fvjmet",
  };
  assert.equal(useP520LlamaCpp(valid), true);
  assert.equal(useP520LlamaCpp({ ...valid, enabled: "true" }), false);
  assert.equal(useP520LlamaCpp({ ...valid, platform: "linux" }), false);
  assert.equal(useP520LlamaCpp({ ...valid, hostname: "P720" }), false);
  assert.equal(useP520LlamaCpp({ ...valid, deviceId: "other" }), false);
});

test("P520 status verifies fixed model identity and localhost llama.cpp health", async (t) => {
  const { port, requests } = await serverFor(t, responder);
  const client = createLlamaCppLocalModelClient({ port });
  const value = await client.status();
  assert.equal(value.available, true);
  assert.equal(value.provider, "local-llamacpp");
  assert.deepEqual(value.models, [MODEL]);
  assert.equal(value.cloudFallback, false);
  assert.equal(value.paidInference, false);
  assert.equal(value.readyForOnDemandUse, true);
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/health", "/v1/models"],
  );
  assert.ok(requests.every((r) => r.method === "GET"));
});

test("occupied llama.cpp slot is not advertised as ready and never receives a prompt", async (t) => {
  const { port, requests } = await serverFor(t, (endpoint) =>
    endpoint === "/health"
      ? [200, { status: "no slot available" }]
      : responder(endpoint),
  );
  const client = createLlamaCppLocalModelClient({ port });
  const status = await client.status();
  assert.equal(status.available, false);
  assert.equal(status.readyForOnDemandUse, false);
  await assert.rejects(
    client.generate({ model: MODEL, prompt: "private project code" }),
    /LOCAL_MODEL_NOT_INSTALLED/,
  );
  assert.ok(requests.every((request) => request.path !== "/completion"));
});

test("active local generation never advertises a second ready slot", async (t) => {
  let signalStarted;
  let releaseCompletion;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const completionGate = new Promise((resolve) => {
    releaseCompletion = resolve;
  });
  const { port, requests } = await serverFor(t, async (endpoint) => {
    if (endpoint === "/completion") {
      signalStarted();
      await completionGate;
    }
    return responder(endpoint);
  });
  const client = createLlamaCppLocalModelClient({ port });
  const first = client.generate({ model: MODEL, prompt: "first request" });
  try {
    await started;
    const during = await client.status();
    assert.equal(during.available, true);
    assert.equal(during.activeRequest, true);
    assert.equal(during.readyForOnDemandUse, false);
    await assert.rejects(
      client.generate({ model: MODEL, prompt: "second request" }),
      /LOCAL_MODEL_BUSY/,
    );
  } finally {
    releaseCompletion();
  }
  await first;
  const after = await client.status();
  assert.equal(after.activeRequest, false);
  assert.equal(after.readyForOnDemandUse, true);
  assert.equal(
    requests.filter((request) => request.path === "/completion").length,
    1,
  );
});

test("exact approved GGUF basename is recognized from Windows path only", async (t) => {
  const { port } = await serverFor(t, (endpoint) =>
    endpoint === "/v1/models"
      ? [200, { data: [{ id: "C:\\KMJ\\Qwen3.5-9B-Q4_K_M.gguf" }] }]
      : responder(endpoint),
  );
  assert.deepEqual(
    (await createLlamaCppLocalModelClient({ port }).status()).models,
    [MODEL],
  );
});

test("unknown model, extra model and arbitrary endpoint are rejected", async (t) => {
  const { port } = await serverFor(t, (endpoint) =>
    endpoint === "/v1/models"
      ? [200, { data: [{ id: "unexpected.gguf" }] }]
      : responder(endpoint),
  );
  const client = createLlamaCppLocalModelClient({ port });
  assert.equal((await client.status()).available, false);
  await assert.rejects(
    client.generate({ model: MODEL, prompt: "test" }),
    /LOCAL_MODEL_NOT_INSTALLED/,
  );
  const { port: extraPort } = await serverFor(t, (endpoint) =>
    endpoint === "/v1/models"
      ? [200, { data: [{ id: MODEL }, { id: "another.gguf" }] }]
      : responder(endpoint),
  );
  assert.equal(
    (await createLlamaCppLocalModelClient({ port: extraPort }).status())
      .available,
    false,
  );
});

test("healthy bounded local generation preserves model attribution and measured timings", async (t) => {
  const { port, requests, sockets } = await serverFor(t, responder);
  const client = createLlamaCppLocalModelClient({ port });
  const result = await client.generate({
    model: MODEL,
    prompt: "Write prime test",
    maxTokens: 64,
  });
  assert.equal(
    sockets.size,
    1,
    "private generation must reuse its verified preflight socket",
  );
  assert.match(result.response, /is_prime/);
  assert.equal(result.model, MODEL);
  assert.equal(result.modelUsage.provider, "local-llamacpp");
  assert.deepEqual(normalizeModelReceipt(result.modelUsage), result.modelUsage);
  assert.equal(result.timing.generationTokensPerSecond, 10);
  assert.equal(result.timing.generationTokens, 20);
  assert.equal(result.hitTokenLimit, false);
  assert.equal(result.modelUnloadRequested, false);
  assert.equal(result.paidInference, false);
  assert.equal(result.cloudFallback, false);
  assert.equal(result.outputIsUntrusted, true);
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/health", "/v1/models", "/completion"],
  );
  assert.deepEqual(requests.at(-1).data, {
    prompt: "Write prime test",
    n_predict: 64,
    temperature: 0,
    seed: 42,
    stream: false,
  });
});

test("closed preflight connection fails closed before sending a private prompt", async (t) => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    if (req.url === "/v1/models") res.setHeader("Connection", "close");
    const [status, reply] = responder(req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createLlamaCppLocalModelClient({
    port: server.address().port,
  });
  await assert.rejects(
    client.generate({ model: MODEL, prompt: "PRIVATE-DO-NOT-SEND" }),
    /LOCAL_MODEL_INFERENCE_FAILED/,
  );
  assert.deepEqual(paths, ["/health", "/v1/models"]);
  assert.equal((await client.status()).activeRequest, false);
});

test("invalid local requests never reach generation endpoint", async (t) => {
  const { port, requests } = await serverFor(t, responder);
  const client = createLlamaCppLocalModelClient({ port });
  await assert.rejects(
    client.generate({ model: "other.gguf", prompt: "hello" }),
    /LOCAL_MODEL_REQUEST_INVALID/,
  );
  await assert.rejects(
    client.generate({ model: MODEL, prompt: "x".repeat(4097) }),
    /LOCAL_MODEL_REQUEST_INVALID/,
  );
  await assert.rejects(
    client.generate({ model: MODEL, prompt: "x", maxTokens: 513 }),
    /LOCAL_MODEL_REQUEST_INVALID/,
  );
  await assert.rejects(
    client.generate({ model: MODEL, prompt: "x", timeoutSeconds: 91 }),
    /LOCAL_MODEL_REQUEST_INVALID/,
  );
  assert.deepEqual(requests, []);
  for (const badPort of [-1, 0, 65536, "20145"]) {
    assert.throws(
      () => createLlamaCppLocalModelClient({ port: badPort }),
      /LOCAL_MODEL_INVALID_PORT/,
    );
  }
});

test("missing daemon or model endpoint fails closed without cloud fallback", async (t) => {
  const { port } = await serverFor(t, () => [500, { error: "no model" }]);
  const client = createLlamaCppLocalModelClient({ port });
  const status = await client.status();
  assert.equal(status.available, false);
  assert.deepEqual(status.models, []);
  assert.equal(status.cloudFallback, false);
  await assert.rejects(
    client.generate({ model: MODEL, prompt: "hello" }),
    /LOCAL_MODEL_NOT_RUNNING/,
  );
});

test("empty responses and failed inference do not claim success", async (t) => {
  const { port } = await serverFor(t, (endpoint) =>
    endpoint === "/completion"
      ? [200, { content: "   " }]
      : responder(endpoint),
  );
  const client = createLlamaCppLocalModelClient({ port });
  await assert.rejects(
    client.generate({ model: MODEL, prompt: "test" }),
    /LOCAL_MODEL_NO_VISIBLE_OUTPUT/,
  );
  assert.equal((await client.status()).activeRequest, false);
  const { port: failPort } = await serverFor(t, (endpoint) =>
    endpoint === "/completion" ? [500, { error: "oom" }] : responder(endpoint),
  );
  await assert.rejects(
    createLlamaCppLocalModelClient({ port: failPort }).generate({
      model: MODEL,
      prompt: "test",
    }),
    /LOCAL_MODEL_INFERENCE_FAILED/,
  );
});

test("bounded inference excludes fake timings and flags true token limits", async (t) => {
  const { port } = await serverFor(t, (endpoint) =>
    endpoint === "/completion"
      ? [
          200,
          {
            content: "x",
            stopped_limit: true,
            tokens_predicted: 64,
            timings: { predicted_per_second: "fake" },
          },
        ]
      : responder(endpoint),
  );
  const value = await createLlamaCppLocalModelClient({ port }).generate({
    model: MODEL,
    prompt: "test",
    maxTokens: 64,
  });
  assert.equal(value.hitTokenLimit, true);
  assert.equal(value.timing.generationTokensPerSecond, null);
});

test("record normalizer rejects unapproved providers and preserves legacy Ollama", () => {
  const ollama = localModelReceipt("qwen3:4b", "local_model_generate");
  assert.equal(ollama.provider, "local-ollama");
  assert.deepEqual(normalizeModelReceipt(ollama), ollama);
  assert.throws(
    () => normalizeModelReceipt({ ...ollama, provider: "external-cloud" }),
    /INVALID_MODEL_ATTRIBUTION/,
  );
});
