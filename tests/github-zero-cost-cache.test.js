import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubBridge } from "../src/github.js";

const repo = "kmjtechno/kmj-codebridge";
const base = {
  apiBase: "https://api.github.com/",
  publicReadOnly: true,
  repositories: [repo],
  cacheSeconds: 0,
};

const repository = {
  full_name: repo,
  default_branch: "main",
  private: false,
  archived: false,
  visibility: "public",
  updated_at: "2026-10-16T00:00:00Z",
};

test("public bridge reuses a scoped ETag after TTL, without inventing readiness", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(options.headers);
    if (calls.length === 1)
      return Response.json(repository, {
        headers: { etag: 'W/"repo-1"' },
      });
    return new Response(null, { status: 304 });
  });
  const bridge = createGitHubBridge(base);
  const first = await bridge("github_repository", { repository: repo });
  const second = await bridge("github_repository", { repository: repo });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, undefined);
  assert.equal(calls[1]["if-none-match"], 'W/"repo-1"');
  assert.equal(calls[1].authorization, undefined);
});

test("many concurrent cached-read requests share one real upstream HTTP request", async (t) => {
  const calls = [];
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(options);
    await barrier;
    return Response.json(repository);
  });
  const bridge = createGitHubBridge({ ...base, cacheSeconds: 60 });
  const pending = Array.from({ length: 12 }, () =>
    bridge("github_repository", { repository: repo }),
  );
  assert.equal(calls.length, 1);
  release();
  const values = await Promise.all(pending);
  assert.ok(values.every((v) => v.default_branch === "main"));
  assert.equal(calls.length, 1);
  await bridge("github_repository", { repository: repo });
  assert.equal(calls.length, 1, "short TTL must still avoid repeat calls");
});

test("quota error fails closed even when a previous representation was cached", async (t) => {
  let count = 0;
  t.mock.method(globalThis, "fetch", async () => {
    count++;
    if (count === 1)
      return Response.json(repository, {
        headers: { etag: '"repo-a"' },
      });
    return new Response(null, {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    });
  });
  const bridge = createGitHubBridge(base);
  await bridge("github_repository", { repository: repo });
  await assert.rejects(
    bridge("github_repository", { repository: repo }),
    /GITHUB_RATE_LIMIT/,
  );
  assert.equal(count, 2);
});

test("unsolicited 304 and malformed ETags cannot create false cached success", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(options.headers);
    if (calls.length === 1) return new Response(null, { status: 304 });
    if (calls.length === 2)
      return Response.json(repository, {
        headers: { etag: "invalid-etag" },
      });
    return Response.json(repository);
  });
  const bridge = createGitHubBridge(base);
  await assert.rejects(
    bridge("github_repository", { repository: repo }),
    /GITHUB_RESPONSE_INVALID/,
  );
  await bridge("github_repository", { repository: repo });
  await bridge("github_repository", { repository: repo });
  assert.equal(calls[2]["if-none-match"], undefined);
});

test("cache/ETag never widens repository allowlist", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(repository);
  });
  const bridge = createGitHubBridge(base);
  await assert.rejects(
    bridge("github_repository", { repository: "other/private-repo" }),
    /GITHUB_REPOSITORY_DENIED/,
  );
  assert.equal(calls, 0);
});
