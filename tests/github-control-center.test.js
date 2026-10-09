import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubBridge } from "../src/github.js";

const repository = "kmjtechno/kmj-cinecore";
const SHA = "a".repeat(40);

function bridge(t, readOnly = false) {
  const tokenEnv = "CODEBRIDGE_GH_CONTROL_CENTER_TEST_TOKEN";
  process.env[tokenEnv] = "x".repeat(40);
  t.after(() => delete process.env[tokenEnv]);
  return createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv,
    publicReadOnly: readOnly,
    repositories: [repository],
    cacheSeconds: 30,
  });
}
function resp(value, status = 200) {
  return Response.json(value, { status });
}
function pathOf(url) {
  return new URL(String(url)).pathname;
}

test("one call lists bounded PR metadata without exposing credentials", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.authorization });
    return resp([
      {
        number: 28,
        title: "Qt runtime",
        state: "open",
        draft: false,
        head: { sha: SHA, ref: "fix/qt" },
        base: { ref: "main" },
        updated_at: "2026-10-09T00:00:00Z",
        html_url: "https://github.com/kmjtechno/kmj-cinecore/pull/28",
      },
    ]);
  });
  const result = await bridge(t)("github_pull_requests", {
    repository,
    state: "open",
    limit: 1,
  });
  assert.equal(result.pullRequests[0].head, SHA);
  assert.equal(result.pullRequests[0].number, 28);
  assert.equal(result.possiblyMore, true);
  assert.ok(calls[0].url.includes("pulls?state=open&per_page=1"));
  assert.ok(!JSON.stringify(result).includes("x".repeat(20)));
  assert.match(calls[0].auth, /^Bearer /);
});

test("CI returns green only with complete exact-head checks AND workflow evidence", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const p = pathOf(url);
    requests.push(String(url));
    if (p.endsWith("/pulls/30"))
      return resp({
        state: "open",
        draft: true,
        head: { sha: SHA },
      });
    if (p.endsWith("/check-runs"))
      return resp({
        total_count: 2,
        check_runs: [
          { name: "ubuntu", status: "completed", conclusion: "success" },
          { name: "windows", status: "completed", conclusion: "success" },
        ],
      });
    if (p.endsWith("/actions/runs"))
      return resp({
        total_count: 1,
        workflow_runs: [
          {
            id: 17,
            name: "CineCore CI",
            status: "completed",
            conclusion: "success",
            head_sha: SHA,
          },
        ],
      });
    throw Error("Unexpected endpoint");
  });
  const value = await bridge(t)("github_pull_request_ci", {
    repository,
    number: 30,
  });
  assert.equal(value.head, SHA);
  assert.equal(value.draft, true);
  assert.equal(value.verdict, "green");
  assert.equal(value.verifiedComplete, true);
  assert.equal(value.checks.length, 2);
  assert.equal(value.workflows.length, 1);
  assert.ok(requests.some((url) => url.includes("head_sha=" + SHA)));
  assert.ok(!requests.some((url) => url.includes("token=")));
});

test("CI refuses false green for queued, failed, missing or truncated evidence", async (t) => {
  let state = "pending";
  t.mock.method(globalThis, "fetch", async (url) => {
    const p = pathOf(url);
    if (p.endsWith("/pulls/28"))
      return resp({
        state: "open",
        head: { sha: SHA },
        draft: false,
      });
    if (p.endsWith("/check-runs"))
      return resp({
        total_count: state === "missing" ? 0 : state === "truncated" ? 101 : 1,
        check_runs: [
          { name: "Windows", status: "completed", conclusion: "success" },
        ],
      });
    if (p.endsWith("/actions/runs"))
      return resp({
        total_count: state === "missing" ? 0 : 1,
        workflow_runs:
          state === "missing"
            ? []
            : [
                {
                  id: 22,
                  name: "CI",
                  status: state === "pending" ? "queued" : "completed",
                  conclusion: state === "failed" ? "failure" : "success",
                  head_sha: SHA,
                },
              ],
      });
    throw Error("Unexpected endpoint");
  });
  const dispatch = bridge(t);
  for (const [scenario, expected] of [
    ["pending", "pending"],
    ["failed", "failed"],
    ["missing", "unverified"],
    ["truncated", "unverified"],
  ]) {
    state = scenario;
    const r = await dispatch("github_pull_request_ci", {
      repository,
      number: 28,
    });
    assert.equal(r.verdict, expected, scenario);
    assert.equal(r.verifiedComplete, false);
  }
});

test("issue read and bounded comment pages use repository allowlist", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const p = String(url);
    if (p.includes("/issues/22/comments"))
      return resp([
        {
          id: 10,
          body: "Status updated",
          user: { login: "reviewer" },
          created_at: "2026-10-09T10:00:00Z",
        },
      ]);
    if (p.endsWith("/issues/22"))
      return resp({
        number: 22,
        title: "Motion QA",
        body: "Hardware remains pending",
        state: "open",
        updated_at: "2026-10-09T10:00:00Z",
        labels: [{ name: "P0" }, { name: "blocked" }],
        html_url: "https://github.com/kmjtechno/kmj-cinecore/issues/22",
      });
    throw Error("Unexpected endpoint");
  });
  const dispatch = bridge(t);
  const issue = await dispatch("github_issue", { repository, number: 22 });
  const comments = await dispatch("github_issue_comments", {
    repository,
    number: 22,
    limit: 20,
  });
  assert.deepEqual(issue.labels, ["P0", "blocked"]);
  assert.equal(comments.comments[0].author, "reviewer");
  await assert.rejects(
    dispatch("github_issue", { repository: "other/private", number: 22 }),
    /GITHUB_REPOSITORY_DENIED/,
  );
});

test("write operations use fixed GitHub API endpoints and never return the token", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const p = pathOf(url);
    writes.push({ url: p, options });
    if (p.endsWith("/repos/kmjtechno/kmj-cinecore/"))
      return resp({
        full_name: repository,
        default_branch: "main",
      });
    if (p.endsWith("/contents/docs/new.md"))
      return resp({
        content: { path: "docs/new.md", sha: "c".repeat(40) },
        commit: { sha: "d".repeat(40) },
      });
    if (p.endsWith("/issues/22/comments"))
      return resp({
        id: 99,
        html_url:
          "https://github.com/kmjtechno/kmj-cinecore/issues/22#issuecomment-99",
      });
    if (p.endsWith("/issues"))
      return resp(
        {
          number: 32,
          state: "open",
          html_url: "https://github.com/kmjtechno/kmj-cinecore/issues/32",
        },
        201,
      );
    throw Error("Unexpected endpoint " + p);
  });
  const dispatch = bridge(t);
  const issue = await dispatch("github_create_issue", {
    repository,
    title: "Need acceptance",
    body: "QA",
  });
  const comment = await dispatch("github_comment_issue", {
    repository,
    number: 22,
    body: "Test evidence pending",
  });
  const created = await dispatch("github_create_file", {
    repository,
    path: "docs/new.md",
    branch: "feat/new",
    content: "Verified document\n",
    message: "docs: new",
  });
  assert.equal(issue.number, 32);
  assert.equal(comment.id, 99);
  assert.equal(created.commit_sha, "d".repeat(40));
  const body = JSON.parse(
    writes.find((x) => x.url.endsWith("/contents/docs/new.md")).options.body,
  );
  assert.equal(body.sha, undefined);
  assert.equal(
    Buffer.from(body.content, "base64").toString("utf8"),
    "Verified document\n",
  );
  assert.equal(body.branch, "feat/new");
  assert.ok(
    !JSON.stringify({ issue, comment, created }).includes("x".repeat(20)),
  );
  const previousWrites = writes.length;
  await assert.rejects(
    dispatch("github_create_file", {
      repository,
      path: "docs/no.md",
      branch: "main",
      content: "no",
      message: "no",
    }),
    /GITHUB_DEFAULT_BRANCH_WRITE_DENIED/,
  );
  assert.equal(writes.filter((x) => x.options.method === "PUT").length, 1);
  assert.ok(writes.length >= previousWrites);
});

test("public-read mode cannot issue any of the new GitHub write operations", async (t) => {
  const dispatch = bridge(t, true);
  await assert.rejects(
    dispatch("github_create_issue", { repository, title: "no", body: "" }),
    /GITHUB_WRITE_DISABLED/,
  );
  await assert.rejects(
    dispatch("github_comment_issue", { repository, number: 1, body: "no" }),
    /GITHUB_WRITE_DISABLED/,
  );
});

test("CI remains unverified when GitHub returns another commit's workflow", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const p = pathOf(url);
    if (p.endsWith("/pulls/28")) return resp({ state: "open", head: { sha: SHA } });
    if (p.endsWith("/check-runs")) return resp({
      total_count: 1,
      check_runs: [{ name: "build", status: "completed", conclusion: "success" }],
    });
    if (p.endsWith("/actions/runs")) return resp({
      total_count: 1,
      workflow_runs: [{
        id: 78, name: "CI", status: "completed",
        conclusion: "success", head_sha: "b".repeat(40),
      }],
    });
    throw Error("Unexpected endpoint");
  });
  const value = await bridge(t)("github_pull_request_ci", {
    repository, number: 28,
  });
  assert.equal(value.verdict, "unverified");
  assert.equal(value.verifiedComplete, false);
});

test("feature file creation refuses unknown default-branch metadata", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(options.method);
    return resp({ full_name: repository });
  });
  await assert.rejects(
    bridge(t)("github_create_file", {
      repository, path: "docs/new.md", branch: "feat/new",
      content: "safe\n", message: "docs: new",
    }),
    /GITHUB_DEFAULT_BRANCH_UNVERIFIED/,
  );
  assert.deepEqual(calls, ["GET"]);
});
