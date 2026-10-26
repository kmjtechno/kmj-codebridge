import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubBridge } from "../src/github.js";

const REPO = "kmjtechno/kmj-codebridge";
const HEAD = "b".repeat(40);
const ENV = "CODEBRIDGE_CI_TRIAGE_TEST_TOKEN";
const TOKEN = "g".repeat(40);

function setup(t, options = {}) {
  process.env[ENV] = TOKEN;
  t.after(() => delete process.env[ENV]);
  const paths = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const target = String(input);
    paths.push(target);
    assert.equal(init.method, "GET");
    assert.equal(init.headers.authorization, "Bearer " + TOKEN);
    if (target.endsWith("/pulls/7")) {
      return Response.json({
        number: 7,
        head: { sha: options.prHead ?? HEAD },
      });
    }
    if (target.endsWith("/actions/jobs/202")) {
      return Response.json({
        id: 202,
        name: "verify (ubuntu-24.04)",
        status: options.jobStatus ?? "completed",
        conclusion: options.conclusion ?? "failure",
        head_sha: options.jobHead ?? HEAD,
      });
    }
    if (target.endsWith("/actions/jobs/202/logs")) {
      return new Response(
        options.log ??
          "PHPStan error: Model property does not exist\n" +
            "Authorization: Bearer dangerous-hidden-value\n" +
            "error TS2339: a second issue\n",
        { status: 200 },
      );
    }
    throw new Error("Unexpected fetch: " + target);
  });
  return {
    call: createGitHubBridge({
      apiBase: "https://api.github.com/",
      tokenEnv: ENV,
      repositories: [REPO],
      cacheSeconds: 30,
    }),
    paths,
  };
}

const args = {
  repository: REPO,
  number: 7,
  jobId: 202,
  expectedHeadSha: HEAD,
};

test("GitHub failed-job triage returns sanitized bounded actionable diagnostics", async (t) => {
  const f = setup(t);
  const result = await f.call("github_actions_failed_job_triage", args);
  assert.equal(result.verifiedHeadSha, HEAD);
  assert.equal(result.conclusion, "failure");
  assert.equal(result.lines.length, 2);
  assert.equal(result.diagnosis.category, "PHP_STATIC_ANALYSIS");
  assert.equal(result.diagnosis.suggestedGateRole, "type");
  assert.equal(result.diagnosis.rootCauseVerified, false);
  assert.equal(result.action, "READ_ONLY_DIAGNOSTIC");
  assert.equal(f.paths.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /dangerous-hidden-value/);
  assert.doesNotMatch(JSON.stringify(result), /Bearer/);
  assert.doesNotMatch(JSON.stringify(result), /Authorization/);
});

test("GitHub job analysis checks current PR head before reading job logs", async (t) => {
  const f = setup(t, { prHead: "c".repeat(40) });
  await assert.rejects(
    f.call("github_actions_failed_job_triage", args),
    /GITHUB_HEAD_MOVED/,
  );
  assert.equal(f.paths.length, 1);
});

test("GitHub job analysis refuses a job from another commit", async (t) => {
  const f = setup(t, { jobHead: "d".repeat(40) });
  await assert.rejects(
    f.call("github_actions_failed_job_triage", args),
    /GITHUB_HEAD_MISMATCH/,
  );
  assert.equal(f.paths.length, 2);
});

test("GitHub job analysis refuses successful or pending jobs", async (t) => {
  const f = setup(t, { conclusion: "success" });
  await assert.rejects(
    f.call("github_actions_failed_job_triage", args),
    /GITHUB_JOB_NOT_FAILED/,
  );
  assert.equal(f.paths.length, 2);
});

test("GitHub job analysis refuses an unauthorized repository", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.call("github_actions_failed_job_triage", {
      ...args,
      repository: "someoneelse/private",
    }),
    /GITHUB_REPOSITORY_DENIED/,
  );
  assert.equal(f.paths.length, 0);
});

test("large job logs retain final diagnostics instead of BODY_TOO_LARGE", async (t) => {
  const log =
    "ordinary build progress\n".repeat(12000) +
    "Authorization: Bearer dangerous-hidden-value\n" +
    "error TS2339: final compiler failure\n";
  const { call } = setup(t, { log });
  const result = await call("github_actions_failed_job_triage", args);
  assert.deepEqual(result.lines, ["error TS2339: final compiler failure"]);
  assert.equal(result.sourceComplete, true);
  assert.equal(result.sourceBytesRead, Buffer.byteLength(log));
  assert.equal(result.diagnosis.category, "TYPESCRIPT");
  assert.doesNotMatch(JSON.stringify(result), /dangerous-hidden-value/);
});

test("diagnostics retain the last eighteen unique failures with explicit truncation", async (t) => {
  const log = Array.from(
    { length: 30 },
    (_, i) => `error E${1000 + i}: build failure ${i}\n`,
  ).join("");
  const { call } = setup(t, { log });
  const result = await call("github_actions_failed_job_triage", args);
  assert.equal(result.lines.length, 18);
  assert.equal(result.lines.at(-1), "error E1029: build failure 29");
  assert.equal(result.truncated, true);
  assert.equal(result.sourceComplete, true);
});

test("unbounded job logs stop at four MiB without claiming full evidence", async (t) => {
  const log =
    "ordinary progress\n".repeat(300000) +
    "error TS2339: unread final failure\n";
  const { call } = setup(t, { log });
  const result = await call("github_actions_failed_job_triage", args);
  assert.equal(result.sourceBytesRead, 4 * 1024 * 1024);
  assert.equal(result.sourceComplete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.diagnosis.rootCauseVerified, false);
  assert.deepEqual(result.lines, []);
});
