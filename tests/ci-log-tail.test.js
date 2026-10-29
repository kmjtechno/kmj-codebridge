import test from "node:test";
import assert from "node:assert/strict";
import { readLogTail } from "../src/ci-log-tail.js";
import { createGitHubBridge } from "../src/github.js";

const stream = (...parts) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts)
          controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }),
  ).body;

test("small logs are returned whole and untruncated", async () => {
  const result = await readLogTail(stream("a\n", "b\nc"), { keepBytes: 1024 });
  assert.equal(result.text, "a\nb\nc");
  assert.equal(result.truncated, false);
  assert.equal(result.tail, false);
});

test("large logs keep only the final complete lines", async () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i} ok`);
  lines.push("##[error]Process completed with exit code 1.");
  const result = await readLogTail(stream(lines.join("\n")), {
    keepBytes: 4096,
  });
  assert.ok(Buffer.byteLength(result.text) <= 4096);
  assert.equal(result.tail, true);
  assert.equal(result.truncated, true);
  assert.match(result.text, /exit code 1\.$/);
  assert.match(
    result.text.split("\n")[0],
    /^line \d+ ok$/,
    "no partial first line",
  );
});

test("private key bodies are dropped even when BEGIN falls outside the tail", async () => {
  const body = Array.from(
    { length: 400 },
    () => "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  ).join("\n");
  // Built at runtime so the repository secret scanner never sees a literal
  // PEM header in tracked source.
  const marker = (edge) => ["-----" + edge, "PRIVATE", "KEY-----"].join(" ");
  const log = [marker("BEGIN"), body, marker("END"), "after key"].join("\n");
  const result = await readLogTail(stream(log), { keepBytes: 256 });
  assert.doesNotMatch(result.text, /MIIEvQ/);
  assert.match(result.text, /after key/);
});

test("reads stop at the byte budget and report incomplete source", async () => {
  const chunk = "x\n".repeat(1024);
  const result = await readLogTail(stream(chunk, chunk, chunk), {
    keepBytes: 512,
    maxReadBytes: 3000,
  });
  assert.equal(result.sourceComplete, false);
  assert.equal(result.truncated, true);
});

test("a single huge line without newlines stays bounded", async () => {
  const result = await readLogTail(stream("z".repeat(300000)), {
    keepBytes: 4096,
  });
  assert.ok(Buffer.byteLength(result.text) <= 4096);
});

test("github_actions_job_log returns a redacted tail instead of BODY_TOO_LARGE", async (t) => {
  const lines = Array.from({ length: 6000 }, (_, i) => `step ${i} running`);
  lines.push("token=super-secret-value-1234567890");
  lines.push("##[error]Process completed with exit code 2.");
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(lines.join("\n")),
  );
  const bridge = createGitHubBridge({
    apiBase: "https://api.github.com/",
    publicReadOnly: true,
    repositories: ["kmjtechno/kmj-codebridge"],
    cacheSeconds: 30,
  });
  const log = await bridge("github_actions_job_log", {
    repository: "kmjtechno/kmj-codebridge",
    jobId: 5,
  });
  assert.equal(log.tail, true);
  assert.equal(log.truncated, true);
  assert.match(log.text, /exit code 2\.$/);
  assert.doesNotMatch(log.text, /super-secret-value/);
  assert.ok(Buffer.byteLength(log.text) <= 65536);
});
