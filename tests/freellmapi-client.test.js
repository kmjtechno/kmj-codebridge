import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createFreeLlmApiClient } from "../src/freellmapi-client.js";

const KEY = "freellma-test-key-0001";

function fake(handler) {
  return createFreeLlmApiClient({
    apiKey: KEY,
    request: async (r) => handler(r),
  });
}

test("requires a configured key and a sane port", () => {
  assert.throws(() => createFreeLlmApiClient({ apiKey: undefined }), {
    message: "FREELLMAPI_KEY_NOT_CONFIGURED",
  });
  assert.throws(() => createFreeLlmApiClient({ apiKey: KEY, port: 80 }), {
    message: "FREELLMAPI_INVALID_PORT",
  });
});

test("generate needs consent, an auto:<chain> name and bounded inputs", async () => {
  const c = fake(() => assert.fail("must not call upstream"));
  const base = { prompt: "hi", localProcessingApproved: true };
  const bad = (patch, code) =>
    assert.rejects(c.generate({ ...base, ...patch }), { message: code });
  await bad(
    { localProcessingApproved: undefined },
    "FREELLMAPI_CONSENT_REQUIRED",
  );
  await bad({ chain: "gpt-5" }, "FREELLMAPI_CHAIN_NOT_ALLOWED");
  await bad({ chain: "auto:../x" }, "FREELLMAPI_CHAIN_NOT_ALLOWED");
  await bad({ prompt: "" }, "FREELLMAPI_INVALID_PROMPT");
  await bad({ maxTokens: 1 }, "FREELLMAPI_INVALID_MAX_TOKENS");
  await bad({ timeoutSeconds: 500 }, "FREELLMAPI_INVALID_TIMEOUT");
});

test("generate returns untrusted, non-applied output with no paid flag", async () => {
  let seen;
  const c = fake((r) => {
    seen = r;
    return {
      choices: [{ message: { content: "ok" }, finish_reason: "length" }],
    };
  });
  const out = await c.generate({ prompt: "hi", localProcessingApproved: true });
  assert.equal(seen.path, "/v1/chat/completions");
  assert.equal(seen.body.model, "auto:default");
  assert.equal(seen.body.max_tokens, 256);
  assert.equal(out.response, "ok");
  assert.equal(out.hitTokenLimit, true);
  assert.equal(out.outputIsUntrusted, true);
  assert.equal(out.paidInference, false);
  assert.equal(out.cloudFallback, false);
  assert.equal(out.writesApplied, false);
});

test("status lists only auto chains and never echoes the key", async () => {
  const c = fake(() => ({
    data: [
      { id: "auto:default" },
      { id: "gpt-oss-20b" },
      { id: "auto:bad name" },
    ],
  }));
  const s = await c.status();
  assert.deepEqual(s.chains, ["auto:default"]);
  assert.equal(s.modelCount, 3);
  assert.ok(!JSON.stringify(s).includes(KEY));
});

test("real HTTP path: loopback only, bearer sent, 429 maps to quota error", async () => {
  let auth;
  const server = http.createServer((req, res) => {
    auth = req.headers.authorization;
    res.statusCode = 429;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const c = createFreeLlmApiClient({ apiKey: KEY, port });
    await assert.rejects(c.status(), { message: "FREELLMAPI_QUOTA_EXHAUSTED" });
    assert.equal(auth, `Bearer ${KEY}`);
  } finally {
    server.close();
  }
});

import { candidateChains } from "../src/freellmapi-client.js";

test("candidateChains prefers task chains the router really has", () => {
  assert.deepEqual(candidateChains("code", ["auto:default", "auto:code"]), [
    "auto:code",
    "auto:default",
  ]);
  assert.deepEqual(candidateChains("fast", ["auto:default"]), ["auto:default"]);
  assert.deepEqual(candidateChains("reasoning", []), ["auto:default"]);
  assert.deepEqual(candidateChains("bogus", ["auto:default"]), [
    "auto:default",
  ]);
});

test("generateRouted routes by task and retries one next chain on quota", async () => {
  const calls = [];
  const c = createFreeLlmApiClient({
    apiKey: KEY,
    request: async (r) => {
      if (r.path === "/v1/models")
        return { data: [{ id: "auto:default" }, { id: "auto:code" }] };
      calls.push(r.body.model);
      if (r.body.model === "auto:code")
        throw new Error("FREELLMAPI_QUOTA_EXHAUSTED");
      return {
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      };
    },
  });
  const out = await c.generateRouted({
    task: "code",
    prompt: "hi",
    localProcessingApproved: true,
  });
  assert.deepEqual(calls, ["auto:code", "auto:default"]);
  assert.equal(out.routing.chosen, "auto:default");
  assert.deepEqual(out.routing.attempts, [
    { chain: "auto:code", outcome: "quota_exhausted" },
  ]);
});

test("generateRouted fails closed when every chain is exhausted or task invalid", async () => {
  const c = createFreeLlmApiClient({
    apiKey: KEY,
    request: async (r) => {
      if (r.path === "/v1/models") return { data: [{ id: "auto:default" }] };
      throw new Error("FREELLMAPI_QUOTA_EXHAUSTED");
    },
  });
  const args = { prompt: "hi", localProcessingApproved: true };
  await assert.rejects(c.generateRouted(args), {
    message: "FREELLMAPI_QUOTA_EXHAUSTED",
  });
  await assert.rejects(c.generateRouted({ ...args, task: "x" }), {
    message: "FREELLMAPI_INVALID_TASK",
  });
});
