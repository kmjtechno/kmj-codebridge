import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubBridge } from "../src/github.js";

function json(data, status = 200) {
  return Response.json(data, { status });
}

test("GitHub bridge keeps credential server-side, enforces allowlist and caches reads", async (t) => {
  process.env.CODEBRIDGE_TEST_GITHUB_TOKEN = "g".repeat(40);
  t.after(() => delete process.env.CODEBRIDGE_TEST_GITHUB_TOKEN);

  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({
      url: String(url),
      authorization: options.headers.authorization,
      method: options.method,
      body: options.body,
    });
    if (String(url).endsWith("/repos/kmjtechno/kmj-codebridge/"))
      return json({
        full_name: "kmjtechno/kmj-codebridge",
        default_branch: "main",
        private: false,
        archived: false,
        visibility: "public",
        updated_at: "2026-10-01T00:00:00Z",
      });
    throw new Error("unexpected fetch");
  });

  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: "CODEBRIDGE_TEST_GITHUB_TOKEN",
    repositories: ["kmjtechno/kmj-codebridge"],
    cacheSeconds: 30,
  });

  const first = await dispatch("github_repository", {
    repository: "kmjtechno/kmj-codebridge",
  });
  const second = await dispatch("github_repository", {
    repository: "kmjtechno/kmj-codebridge",
  });

  assert.deepEqual(first, second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, `Bearer ${"g".repeat(40)}`);
  assert.ok(!JSON.stringify(first).includes("g".repeat(20)));

  await assert.rejects(
    dispatch("github_repository", { repository: "other/repo" }),
    /GITHUB_REPOSITORY_DENIED/,
  );
});

test("GitHub bridge reads PRs, files, workflow runs, jobs and bounded logs", async (t) => {
  process.env.CODEBRIDGE_TEST_GITHUB_TOKEN = "h".repeat(40);
  t.after(() => delete process.env.CODEBRIDGE_TEST_GITHUB_TOKEN);

  t.mock.method(globalThis, "fetch", async (url) => {
    const value = String(url);
    if (value.includes("/pulls/7/files"))
      return json([
        {
          filename: "src/a.js",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ]);
    if (value.endsWith("/pulls/7"))
      return json({
        number: 7,
        title: "Fix",
        state: "open",
        draft: false,
        mergeable: true,
        head: { sha: "a".repeat(40), ref: "fix" },
        base: { sha: "b".repeat(40), ref: "main" },
        changed_files: 1,
        additions: 3,
        deletions: 1,
        updated_at: "2026-10-01T00:00:00Z",
      });
    if (value.includes("/actions/runs?"))
      return json({
        workflow_runs: [
          {
            id: 101,
            name: "CI",
            status: "completed",
            conclusion: "success",
            head_sha: "c".repeat(40),
            head_branch: "main",
            event: "push",
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:01:00Z",
          },
        ],
      });
    if (value.includes("/actions/runs/101/jobs"))
      return json({
        jobs: [
          {
            id: 202,
            name: "verify",
            status: "completed",
            conclusion: "success",
            started_at: "2026-10-01T00:00:00Z",
            completed_at: "2026-10-01T00:01:00Z",
          },
        ],
      });
    if (value.includes("/actions/jobs/202/logs"))
      return new Response("token=super-secret-value\nPASS\n", { status: 200 });
    throw new Error(`unexpected fetch ${value}`);
  });

  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: "CODEBRIDGE_TEST_GITHUB_TOKEN",
    repositories: ["kmjtechno/kmj-codebridge"],
    cacheSeconds: 30,
  });

  const pr = await dispatch("github_pull_request", {
    repository: "kmjtechno/kmj-codebridge",
    number: 7,
  });
  assert.equal(pr.head_ref, "fix");

  const files = await dispatch("github_pull_request_files", {
    repository: "kmjtechno/kmj-codebridge",
    number: 7,
  });
  assert.equal(files.files[0].filename, "src/a.js");

  const runs = await dispatch("github_actions_runs", {
    repository: "kmjtechno/kmj-codebridge",
    branch: "main",
    limit: 10,
  });
  assert.equal(runs.runs[0].id, 101);

  const jobs = await dispatch("github_actions_run_jobs", {
    repository: "kmjtechno/kmj-codebridge",
    runId: 101,
  });
  assert.equal(jobs.jobs[0].id, 202);

  const log = await dispatch("github_actions_job_log", {
    repository: "kmjtechno/kmj-codebridge",
    jobId: 202,
  });
  assert.match(log.text, /token=\[REDACTED\]/);
  assert.doesNotMatch(log.text, /super-secret-value/);
});

test("GitHub bridge creates branches and pull requests without returning the credential", async (t) => {
  process.env.CODEBRIDGE_TEST_GITHUB_TOKEN = "i".repeat(40);
  t.after(() => delete process.env.CODEBRIDGE_TEST_GITHUB_TOKEN);

  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      body: options.body,
    });
    if (String(url).endsWith("/git/refs"))
      return json(
        {
          ref: "refs/heads/feature",
          object: { sha: "a".repeat(40) },
        },
        201,
      );
    if (String(url).endsWith("/pulls"))
      return json(
        {
          number: 9,
          title: "Feature",
          state: "open",
          head: { sha: "a".repeat(40) },
          base: { sha: "b".repeat(40) },
          html_url: "https://github.com/kmjtechno/kmj-codebridge/pull/9",
        },
        201,
      );
    throw new Error("unexpected fetch");
  });

  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: "CODEBRIDGE_TEST_GITHUB_TOKEN",
    repositories: ["kmjtechno/kmj-codebridge"],
    cacheSeconds: 30,
  });

  const branch = await dispatch("github_create_branch", {
    repository: "kmjtechno/kmj-codebridge",
    branch: "feature",
    sha: "a".repeat(40),
  });
  assert.equal(branch.ref, "refs/heads/feature");

  const pr = await dispatch("github_create_pull_request", {
    repository: "kmjtechno/kmj-codebridge",
    title: "Feature",
    body: "Body",
    head: "feature",
    base: "main",
    draft: false,
  });
  assert.equal(pr.number, 9);
  assert.ok(!JSON.stringify(pr).includes("i".repeat(20)));
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);
});

test("GitHub bridge supports credential-free reads only for explicitly public mode", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    return json({
      full_name: "kmjtechno/kmj-codebridge",
      default_branch: "main",
      private: false,
      archived: false,
      visibility: "public",
      updated_at: "2026-10-03T00:00:00Z",
    });
  });

  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    publicReadOnly: true,
    repositories: ["kmjtechno/kmj-codebridge"],
    cacheSeconds: 30,
  });

  const repo = await dispatch("github_repository", {
    repository: "kmjtechno/kmj-codebridge",
  });
  assert.equal(repo.private, false);
  assert.equal(calls[0].options.headers.authorization, undefined);

  await assert.rejects(
    dispatch("github_create_branch", {
      repository: "kmjtechno/kmj-codebridge",
      branch: "no-write",
      sha: "a".repeat(40),
    }),
    /GITHUB_WRITE_DISABLED/,
  );
});

test("GitHub bridge fails closed when configured credential is missing", () => {
  delete process.env.CODEBRIDGE_MISSING_GITHUB_TOKEN;
  assert.throws(
    () =>
      createGitHubBridge({
        apiBase: "https://api.github.com/",
        tokenEnv: "CODEBRIDGE_MISSING_GITHUB_TOKEN",
        repositories: ["kmjtechno/kmj-codebridge"],
        cacheSeconds: 30,
      }),
    /GITHUB_CREDENTIAL_MISSING/,
  );
});
