import test from "node:test";
import assert from "node:assert/strict";
import {
  createGitHubBridge,
  GITHUB_CACHE_MAX_BYTES,
  GITHUB_CACHE_MAX_ENTRIES,
  GITHUB_JSON_MAX_BYTES,
} from "../src/github.js";

const repo = "kmjtechno/kmj-codebridge";
const base = {
  apiBase: "https://api.github.com/",
  publicReadOnly: true,
  repositories: [repo],
  cacheSeconds: 60,
};

// Realistic GitHub REST pages embed whole repository/user objects per item.
const heavy = (n) => ({ blob: "x".repeat(n) });

function pulls(count, perItemBytes) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `PR ${index + 1}`,
    state: "open",
    draft: false,
    head: {
      sha: "a".repeat(40),
      ref: `branch-${index}`,
      repo: heavy(perItemBytes),
    },
    base: { ref: "main", repo: heavy(perItemBytes) },
    updated_at: "2026-10-29T00:00:00Z",
    html_url: `https://github.com/${repo}/pull/${index + 1}`,
  }));
}

test("advertised pull request page size does not fail on large raw GitHub JSON", async (t) => {
  // 30 PRs x ~30 KiB is ~900 KiB raw: previously rejected at 256 KiB.
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(pulls(30, 15000)),
  );
  const bridge = createGitHubBridge(base);
  const result = await bridge("github_pull_requests", {
    repository: repo,
    state: "open",
    limit: 30,
  });
  assert.equal(result.pullRequests.length, 30);
  assert.equal(result.pullRequests[29].number, 30);
  assert.equal(result.possiblyMore, true);
  // Projection stays small and never echoes embedded repository objects.
  assert.ok(JSON.stringify(result).length < 16384);
  assert.equal(JSON.stringify(result).includes("xxxx"), false);
});

test("advertised workflow run page size does not fail on large raw GitHub JSON", async (t) => {
  const runs = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    name: "CodeBridge CI",
    status: "completed",
    conclusion: "success",
    head_sha: "b".repeat(40),
    head_branch: "main",
    event: "push",
    created_at: "2026-10-29T00:00:00Z",
    updated_at: "2026-10-29T00:01:00Z",
    repository: heavy(12000),
    head_repository: heavy(12000),
  }));
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ total_count: 50, workflow_runs: runs }),
  );
  const bridge = createGitHubBridge(base);
  const result = await bridge("github_actions_runs", {
    repository: repo,
    branch: "main",
    limit: 50,
  });
  assert.equal(result.runs.length, 50);
});

test("oversized GitHub responses fail closed with a GitHub-specific code", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify([heavy(GITHUB_JSON_MAX_BYTES + 10)]), {
        headers: { "content-type": "application/json" },
      }),
  );
  const bridge = createGitHubBridge(base);
  await assert.rejects(
    bridge("github_pull_requests", {
      repository: repo,
      state: "open",
      limit: 5,
    }),
    (error) => error.code === "GITHUB_RESPONSE_TOO_LARGE",
  );
});

test("malformed GitHub JSON is reported as an invalid GitHub response", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{not json", { status: 200 }),
  );
  const bridge = createGitHubBridge(base);
  await assert.rejects(
    bridge("github_repository", { repository: repo }),
    (error) => error.code === "GITHUB_RESPONSE_INVALID",
  );
});

test("read cache stays bounded by entry count and evicts oldest keys", async (t) => {
  assert.ok(GITHUB_CACHE_MAX_BYTES >= GITHUB_JSON_MAX_BYTES);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ total_count: 0, workflow_runs: [] });
  });
  const bridge = createGitHubBridge(base);
  const read = (index) =>
    bridge("github_actions_runs", {
      repository: repo,
      branch: `lane-${index}`,
      limit: 1,
    });
  const total = GITHUB_CACHE_MAX_ENTRIES + 10;
  for (let index = 0; index < total; index++) await read(index);
  assert.equal(calls, total);
  await read(total - 1); // newest key is still cached
  assert.equal(calls, total);
  await read(0); // oldest key was evicted by the entry bound
  assert.equal(calls, total + 1);
});
