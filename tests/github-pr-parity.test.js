import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubBridge, githubDefinitions } from "../src/github.js";

const repository = "kmjtechno/kmj-codebridge";
const head = "a".repeat(40);
const json = (data, status = 200) => Response.json(data, { status });

function bridge(t, extra = {}) {
  const credentialEnv = ["CODEBRIDGE_TEST_PARITY", "TOKEN"].join("_");
  process.env[credentialEnv] = "k".repeat(40);
  t.after(() => delete process.env[credentialEnv]);
  return createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: credentialEnv,
    repositories: [repository],
    cacheSeconds: 30,
    ...extra,
  });
}

function mockFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const call = {
      url: String(url).replace("https://api.github.com/repos/", ""),
      method: options.method,
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

test("new tools are registered with the right access class", () => {
  for (const name of ["github_pull_request_reviews", "github_commits"])
    assert.equal(githubDefinitions[name].access, "read");
  for (const name of [
    "github_update_pull_request",
    "github_review_pull_request",
    "github_reply_review_comment",
  ])
    assert.equal(githubDefinitions[name].access, "write");
});

test("pull-request reviews and inline comments are bounded and redacted", async (t) => {
  mockFetch(t, (c) => {
    if (c.url.endsWith("pulls/7/reviews?per_page=30"))
      return json([
        {
          id: 1,
          user: { login: "reviewer" },
          state: "CHANGES_REQUESTED",
          commit_id: head,
          submitted_at: "2026-10-13T10:00:00Z",
          body: "please fix token=supersecretvalue123 " + "x".repeat(9000),
        },
      ]);
    if (c.url.endsWith("pulls/7/comments?per_page=30"))
      return json([
        {
          id: 9,
          user: { login: "reviewer" },
          path: "src/a.js",
          line: 12,
          in_reply_to_id: null,
          created_at: "2026-10-13T10:01:00Z",
          body: "nit",
        },
      ]);
    throw new Error(`unexpected ${c.method} ${c.url}`);
  });
  const r = await bridge(t)("github_pull_request_reviews", {
    repository,
    number: 7,
  });
  assert.equal(r.reviews[0].state, "CHANGES_REQUESTED");
  assert.ok(r.reviews[0].body.length <= 4000);
  assert.ok(!r.reviews[0].body.includes("supersecretvalue123"));
  assert.deepEqual(
    { path: r.comments[0].path, line: r.comments[0].line },
    { path: "src/a.js", line: 12 },
  );
});

test("commit list returns SHA, first message line and author only", async (t) => {
  const calls = mockFetch(t, () =>
    json([
      {
        sha: head,
        commit: {
          message: "feat: add thing\n\nlong body that must not be returned",
          author: { name: "Dev", date: "2026-10-13T09:00:00Z" },
        },
        author: { login: "ignored" },
      },
    ]),
  );
  const r = await bridge(t)("github_commits", {
    repository,
    ref: "feature/x",
    limit: 5,
  });
  assert.deepEqual(r.commits, [
    {
      sha: head,
      message: "feat: add thing",
      author: "Dev",
      date: "2026-10-13T09:00:00Z",
    },
  ]);
  assert.match(calls[0].url, /commits\?per_page=5&sha=feature%2Fx$/);
});

test("update_pull_request sends only the supplied fields and refuses empty or unknown changes", async (t) => {
  const calls = mockFetch(t, () =>
    json({
      number: 7,
      title: "New title",
      state: "open",
      draft: true,
      base: { ref: "main" },
      head: { sha: head },
      html_url: "https://github.com/x/y/pull/7",
    }),
  );
  const dispatch = bridge(t);
  const r = await dispatch("github_update_pull_request", {
    repository,
    number: 7,
    title: "New title",
    state: "open",
  });
  assert.equal(calls[0].method, "PATCH");
  assert.match(calls[0].url, /pulls\/7$/);
  assert.deepEqual(calls[0].body, { title: "New title", state: "open" });
  assert.equal(r.draft, true);
  await assert.rejects(
    dispatch("github_update_pull_request", { repository, number: 7 }),
    /GITHUB_PULL_REQUEST_NO_CHANGES/,
  );
  // No merge/draft/maintainer fields can be smuggled through this tool.
  await assert.rejects(
    dispatch("github_update_pull_request", {
      repository,
      number: 7,
      title: "t",
      draft: false,
    }),
  );
  await assert.rejects(
    dispatch("github_update_pull_request", {
      repository,
      number: 7,
      state: "merged",
    }),
  );
  assert.equal(calls.length, 1);
});

test("review_pull_request cannot approve and honours the expected head", async (t) => {
  const calls = mockFetch(t, (c) => {
    if (c.method === "GET") return json({ state: "open", head: { sha: head } });
    return json({
      id: 5,
      state: "COMMENTED",
      html_url: "https://github.com/x/y/pull/7#pullrequestreview-5",
    });
  });
  const dispatch = bridge(t);
  await assert.rejects(
    dispatch("github_review_pull_request", {
      repository,
      number: 7,
      event: "APPROVE",
      body: "lgtm",
    }),
  );
  assert.equal(calls.length, 0);

  await assert.rejects(
    dispatch("github_review_pull_request", {
      repository,
      number: 7,
      event: "COMMENT",
      body: "stale",
      expectedHeadSha: "b".repeat(40),
    }),
    /GITHUB_HEAD_MOVED/,
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET"],
  );

  const ok = await dispatch("github_review_pull_request", {
    repository,
    number: 7,
    event: "REQUEST_CHANGES",
    body: "needs a test",
    expectedHeadSha: head,
  });
  assert.equal(ok.id, 5);
  const post = calls.at(-1);
  assert.equal(post.method, "POST");
  assert.match(post.url, /pulls\/7\/reviews$/);
  assert.deepEqual(post.body, {
    body: "needs a test",
    event: "REQUEST_CHANGES",
    commit_id: head,
  });
});

test("reply_review_comment targets exactly one comment thread", async (t) => {
  const calls = mockFetch(t, () =>
    json({ id: 11, html_url: "https://github.com/x/y/pull/7#discussion_r11" }),
  );
  const r = await bridge(t)("github_reply_review_comment", {
    repository,
    number: 7,
    commentId: 9,
    body: "done",
  });
  assert.equal(r.id, 11);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /pulls\/7\/comments\/9\/replies$/);
  assert.deepEqual(calls[0].body, { body: "done" });
});

test("every new tool enforces the repository allowlist and the public read-only mode", async (t) => {
  const calls = mockFetch(t, () => json({}));
  const dispatch = bridge(t);
  const other = "someone/else";
  const inputs = {
    github_pull_request_reviews: { number: 1 },
    github_commits: {},
    github_update_pull_request: { number: 1, title: "t" },
    github_review_pull_request: { number: 1, event: "COMMENT", body: "b" },
    github_reply_review_comment: { number: 1, commentId: 1, body: "b" },
  };
  for (const [name, input] of Object.entries(inputs))
    await assert.rejects(
      dispatch(name, { repository: other, ...input }),
      /GITHUB_REPOSITORY_DENIED/,
      name,
    );
  assert.equal(calls.length, 0);

  const readOnly = createGitHubBridge({
    apiBase: "https://api.github.com/",
    publicReadOnly: true,
    repositories: [repository],
    cacheSeconds: 30,
  });
  for (const name of [
    "github_update_pull_request",
    "github_review_pull_request",
    "github_reply_review_comment",
  ])
    await assert.rejects(
      readOnly(name, { repository, ...inputs[name] }),
      /GITHUB_WRITE_DISABLED/,
      name,
    );
  assert.equal(calls.length, 0);
});
