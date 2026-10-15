import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubBridge } from "../src/github.js";

function json(data, status = 200) {
  return Response.json(data, { status });
}

function writableBridge(t) {
  const credentialEnv = ["CODEBRIDGE_TEST_GITHUB", "TOKEN"].join("_");
  process.env[credentialEnv] = "j".repeat(40);
  t.after(() => delete process.env[credentialEnv]);
  return createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: credentialEnv,
    repositories: ["kmjtechno/kmj-codebridge"],
    cacheSeconds: 30,
  });
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
    if (String(url).endsWith("/repos/kmjtechno/kmj-codebridge"))
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

test("GitHub bridge updates exact files and merges only an exact green head", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const value = String(url);
    calls.push({ url: value, method: options.method, body: options.body });
    if (value.endsWith("/repos/kmjtechno/kmj-codebridge"))
      return json({ default_branch: "main" });
    if (value.endsWith("/contents/src/a.js"))
      return json({
        content: { path: "src/a.js", sha: "b".repeat(40) },
        commit: { sha: "c".repeat(40) },
      });
    if (value.endsWith("/pulls/9"))
      return json({ state: "open", head: { sha: "a".repeat(40) } });
    if (value.includes(`/commits/${"a".repeat(40)}/check-runs`))
      return json({
        total_count: 2,
        check_runs: [
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "success" },
        ],
      });
    if (value.includes(`/actions/runs?head_sha=${"a".repeat(40)}`))
      return json({
        total_count: 1,
        workflow_runs: [
          {
            head_sha: "a".repeat(40),
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    if (value.endsWith("/pulls/9/merge"))
      return json({ merged: true, sha: "d".repeat(40), message: "merged" });
    throw new Error(`unexpected fetch ${value}`);
  });

  const dispatch = writableBridge(t);
  const updated = await dispatch("github_update_file", {
    repository: "kmjtechno/kmj-codebridge",
    path: "src/a.js",
    branch: "feature",
    sha: "a".repeat(40),
    content: "const ok = true;\n",
    message: "fix: exact file",
  });
  assert.equal(updated.content_sha, "b".repeat(40));
  const updateBody = JSON.parse(
    calls.find(
      (call) =>
        call.method === "PUT" && call.url.endsWith("/contents/src/a.js"),
    ).body,
  );
  assert.equal(
    Buffer.from(updateBody.content, "base64").toString("utf8"),
    "const ok = true;\n",
  );
  assert.equal(updateBody.sha, "a".repeat(40));
  assert.equal(updateBody.branch, "feature");

  const merged = await dispatch("github_merge_pull_request", {
    repository: "kmjtechno/kmj-codebridge",
    number: 9,
    expectedHeadSha: "a".repeat(40),
    method: "squash",
  });
  assert.equal(merged.merged, true);
  assert.equal(merged.sha, "d".repeat(40));
  const mergeBody = JSON.parse(calls.at(-1).body);
  assert.equal(mergeBody.sha, "a".repeat(40));
  assert.equal(mergeBody.merge_method, "squash");
});

test("GitHub update file rejects direct writes to default branch even with valid blob SHA", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    if (String(url).endsWith("/repos/kmjtechno/kmj-codebridge"))
      return json({ default_branch: "main" });
    throw Error("UNEXPECTED_GITHUB_MUTATION");
  });
  const dispatch = writableBridge(t);
  await assert.rejects(
    dispatch("github_update_file", {
      repository: "kmjtechno/kmj-codebridge",
      path: "src/secure.js",
      branch: "main",
      sha: "a".repeat(40),
      content: "unsafe mutation",
      message: "fix: should never hit default branch",
    }),
    /GITHUB_DEFAULT_BRANCH_WRITE_DENIED/,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET"],
    "a valid blob SHA must not bypass protected default-branch rules",
  );
});

test("GitHub update file fails closed without verified default branch metadata", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    return json({ default_branch: "not a valid branch" });
  });
  const dispatch = writableBridge(t);
  await assert.rejects(
    dispatch("github_update_file", {
      repository: "kmjtechno/kmj-codebridge",
      path: "src/secure.js",
      branch: "feature",
      sha: "a".repeat(40),
      content: "new code",
      message: "fix: verify branch metadata",
    }),
    /GITHUB_DEFAULT_BRANCH_UNVERIFIED/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

test("GitHub safe merge rejects moved heads and non-green checks", async (t) => {
  let head = "b".repeat(40);
  let green = true;
  t.mock.method(globalThis, "fetch", async (url) => {
    const value = String(url);
    if (value.endsWith("/pulls/9"))
      return json({ state: "open", head: { sha: head } });
    if (value.includes("/check-runs"))
      return json({
        total_count: 1,
        check_runs: [
          {
            status: green ? "completed" : "in_progress",
            conclusion: green ? "success" : null,
          },
        ],
      });
    if (value.includes(`/actions/runs?head_sha=${"a".repeat(40)}`))
      return json({
        total_count: 1,
        workflow_runs: [
          {
            head_sha: "a".repeat(40),
            status: green ? "completed" : "in_progress",
            conclusion: green ? "success" : null,
          },
        ],
      });
    throw new Error(`unexpected fetch ${value}`);
  });

  const dispatch = writableBridge(t);
  await assert.rejects(
    dispatch("github_merge_pull_request", {
      repository: "kmjtechno/kmj-codebridge",
      number: 9,
      expectedHeadSha: "a".repeat(40),
      method: "squash",
    }),
    /GITHUB_HEAD_MOVED/,
  );

  head = "a".repeat(40);
  green = false;
  await assert.rejects(
    dispatch("github_merge_pull_request", {
      repository: "kmjtechno/kmj-codebridge",
      number: 9,
      expectedHeadSha: "a".repeat(40),
      method: "squash",
    }),
    /GITHUB_CHECKS_NOT_GREEN/,
  );
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

test("GitHub explicit public-read-only mode never transmits a configured legacy token", async (t) => {
  const envName = "CODEBRIDGE_TEST_PUBLIC_MODE_SECRET";
  process.env[envName] = "secret-value-not-for-public-requests";
  t.after(() => delete process.env[envName]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      authorization: options.headers.authorization,
    });
    return json({
      full_name: "kmjtechno/kmj-codebridge",
      default_branch: "main",
      private: false,
      archived: false,
      visibility: "public",
      updated_at: "2026-10-12T00:00:00Z",
    });
  });
  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    tokenEnv: envName,
    publicReadOnly: true,
    repositories: ["kmjtechno/kmj-codebridge"],
    cacheSeconds: 30,
  });
  const result = await dispatch("github_repository", {
    repository: "kmjtechno/kmj-codebridge",
  });
  assert.equal(result.private, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, undefined);
  assert.equal(calls[0].method, "GET");
  await assert.rejects(
    dispatch("github_create_branch", {
      repository: "kmjtechno/kmj-codebridge",
      branch: "never-write",
      sha: "a".repeat(40),
    }),
    /GITHUB_WRITE_DISABLED/,
  );
  assert.equal(calls.length, 1);
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

test("native GitHub doctor distinguishes allowlist, auth, rate limit and private repository readiness", async (t) => {
  let responseStatus = 200;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({
      url: String(url),
      authorization: options.headers.authorization,
    });
    if (responseStatus !== 200) {
      return json({}, responseStatus);
    }
    return json({
      full_name: "kmjtechno/kmj-codebridge",
      default_branch: "main",
      private: true,
    });
  });
  const dispatch = writableBridge(t);

  const denied = await dispatch("github_connection_doctor", {
    repository: "other/private-cinecore",
  });
  assert.equal(denied.status, "repository_not_allowed");
  assert.equal(
    calls.length,
    0,
    "unapproved repositories never trigger GitHub requests",
  );

  const ready = await dispatch("github_connection_doctor", {
    repository: "kmjtechno/kmj-codebridge",
  });
  assert.equal(ready.status, "read_ready");
  assert.equal(ready.privateRepository, true);
  assert.equal(
    ready.writeVerified,
    false,
    "a read probe cannot authorize writes",
  );

  responseStatus = 401;
  const rejected = await dispatch("github_connection_doctor", {
    repository: "kmjtechno/kmj-codebridge",
  });
  assert.equal(rejected.status, "authorization_failed");
  assert.equal(rejected.readVerified, false);

  responseStatus = 403;
  const forbidden = await dispatch("github_connection_doctor", {
    repository: "kmjtechno/kmj-codebridge",
  });
  assert.equal(forbidden.status, "authorization_failed");

  responseStatus = 429;
  const throttled = await dispatch("github_connection_doctor", {
    repository: "kmjtechno/kmj-codebridge",
  });
  assert.equal(throttled.status, "rate_limited");

  responseStatus = 404;
  const absent = await dispatch("github_connection_doctor", {
    repository: "kmjtechno/kmj-codebridge",
  });
  assert.equal(absent.status, "not_found_or_not_granted");

  assert.equal(
    calls.length,
    5,
    "doctor checks live GitHub state on each allowed call",
  );
  for (const result of [
    denied,
    ready,
    rejected,
    forbidden,
    throttled,
    absent,
  ]) {
    assert.doesNotMatch(
      JSON.stringify(result),
      /[j]{20}|CODEBRIDGE_TEST_GITHUB_TOKEN/,
    );
  }
});

test("public read-only native GitHub doctor sends no credential and never implies private/write access", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(options.headers.authorization);
    return json({
      full_name: "kmjtechno/kmj-codebridge",
      private: false,
      default_branch: "main",
    });
  });
  const dispatch = createGitHubBridge({
    apiBase: "https://api.github.com/",
    publicReadOnly: true,
    repositories: ["kmjtechno/kmj-codebridge"],
    cacheSeconds: 30,
  });
  const result = await dispatch("github_connection_doctor", {
    repository: "kmjtechno/kmj-codebridge",
  });
  assert.equal(result.status, "read_ready");
  assert.equal(result.mode, "public_read_only");
  assert.equal(result.privateRepository, false);
  assert.equal(result.writeVerified, false);
  assert.deepEqual(calls, [undefined]);
});

test("execution doctor confirms zero-step failure only at matching workflow HEAD", async (t) => {
  const dispatch = writableBridge(t);
  const head = "a".repeat(40);
  t.mock.method(globalThis, "fetch", async (url) => {
    const p = String(url);
    if (p.endsWith("/actions/runs/500"))
      return json({
        id: 500,
        head_sha: head,
        status: "completed",
        conclusion: "failure",
      });
    if (p.includes("/actions/runs/500/jobs"))
      return json({
        total_count: 2,
        jobs: [
          { id: 501, name: "CI startup", status: "completed", conclusion: "failure", steps: [] },
          { id: 502, name: "CI browser", status: "completed", conclusion: "failure", steps: [] },
        ],
      });
    throw new Error("unexpected fetch");
  });
  const r = await dispatch("github_actions_execution_doctor", {
    repository: "kmjtechno/kmj-codebridge",
    runId: 500,
    expectedHeadSha: head,
  });
  assert.equal(r.classification, "FAILED_WITH_ZERO_JOB_STEPS");
  assert.equal(r.zeroStepFailedJobs, 2);
  assert.equal(r.action, "READ_ONLY_DIAGNOSTIC");
  assert.equal(r.codeTestsPassed, false);
  assert.equal(r.localEvidenceIsHostedCi, false);
  assert.match(r.mergeAuthorization, /^BLOCKED/);
});

test("execution doctor rejects moved SHA and never follows a stale run", async (t) => {
  const dispatch = writableBridge(t);
  let jobRequests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/actions/runs/700"))
      return json({
        id: 700,
        head_sha: "b".repeat(40),
        status: "completed",
        conclusion: "failure",
      });
    jobRequests++;
    throw new Error("unexpected fetch");
  });
  await assert.rejects(
    dispatch("github_actions_execution_doctor", {
      repository: "kmjtechno/kmj-codebridge",
      runId: 700,
      expectedHeadSha: "a".repeat(40),
    }),
    /GITHUB_HEAD_MOVED/,
  );
  assert.equal(jobRequests, 0);
});

test("run jobs expose step evidence but keep missing steps explicitly unknown", async (t) => {
  const dispatch = writableBridge(t);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/actions/runs/800/jobs"))
      return json({
        total_count: 2,
        jobs: [
          { id: 801, name: "Startup", status: "completed", conclusion: "failure", steps: [] },
          { id: 802, name: "Missing", status: "completed", conclusion: "failure" },
        ],
      });
    throw new Error("unexpected fetch");
  });
  const r = await dispatch("github_actions_run_jobs", {
    repository: "kmjtechno/kmj-codebridge",
    runId: 800,
  });
  assert.equal(r.evidenceComplete, true);
  assert.equal(r.jobs[0].executionEvidence.execution, "NO_STEPS_RECORDED");
  assert.equal(r.jobs[1].executionEvidence.execution, "STEPS_UNKNOWN");
  assert.equal(r.jobs[0].executionEvidence.applicationTestsVerified, false);
});
