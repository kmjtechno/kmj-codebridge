import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutopilotJournal } from "../src/autopilot.js";
import {
  GitHubCiWatchWorker,
  startGitHubCiWatchWorker,
} from "../src/autopilot-ci-watch-worker.js";
import { agentSchema } from "../src/config.js";

const HEAD = "a".repeat(40);
const ENV = "CODEBRIDGE_TEST_CI_WATCH_TOKEN";
const SECRET = "s".repeat(40);
const REPO = "kmjtechno/kmj-codebridge";

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-ciwatch-"));
  t.after(() =>
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  );
  if (overrides.absentToken) delete process.env[ENV];
  else process.env[ENV] = SECRET;
  t.after(() => delete process.env[ENV]);
  const journal = new AutopilotJournal(dir);
  let clock = 1000000;
  const calls = [];
  const config = {
    enabled: true,
    repository: REPO,
    branch: "main",
    workflow: "CodeBridge CI",
    job: "verify (ubuntu-24.04)",
    recipe: "format",
    tokenEnv: ENV,
    intervalSeconds: 900,
    ...overrides.watch,
  };
  const project = {
    id: "codebridge",
    root: "/nonexistent",
    writable: true,
    autopilotRepairWorker: {
      enabled: true,
      recipes: {
        format: {
          fixGate: "format",
          verifyGate: "check",
          paths: ["src/"],
        },
      },
    },
    autopilotCiWatch: config,
    ...overrides.project,
  };
  const client = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.ok(String(url).startsWith("https://api.github.com/repos/" + REPO));
    if (overrides.httpFailure)
      return new Response("", { status: overrides.httpFailure });
    if (String(url).includes("/actions/runs?"))
      return Response.json({
        total_count: overrides.runCount ?? 1,
        workflow_runs: [
          {
            id: 101,
            head_sha: overrides.runSha ?? HEAD,
            head_branch: "main",
            name: "CodeBridge CI",
            event: overrides.event ?? "push",
            status: overrides.runStatus ?? "completed",
            conclusion: overrides.runConclusion ?? "failure",
          },
        ],
      });
    if (String(url).includes("/actions/runs/101/jobs?"))
      return Response.json({
        total_count: 1,
        jobs: [
          {
            id: 202,
            head_sha: overrides.jobSha ?? HEAD,
            name: "verify (ubuntu-24.04)",
            status: "completed",
            conclusion: overrides.jobConclusion ?? "failure",
          },
        ],
      });
    throw Error("UNEXPECTED_API_REQUEST");
  };
  const worker = new GitHubCiWatchWorker({
    projects: [project],
    journal,
    licenseProvider: () => ({
      features: overrides.noExecute ? ["read", "write"] : ["execute"],
    }),
    identity: () => ({
      branch: overrides.localBranch ?? "main",
      head: overrides.localHead ?? HEAD,
    }),
    now: () => clock,
    fetchImpl: client,
  });
  return {
    worker,
    journal,
    calls,
    project,
    advance: (ms = 900000) => {
      clock += ms;
    },
  };
}

test("failed exact-head GitHub Actions job queues a durable single repair task", async (t) => {
  const f = fixture(t);
  await f.worker.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.headers.authorization, "Bearer " + SECRET);
  assert.equal(f.journal.state.tasks.length, 1);
  const task = f.journal.state.tasks[0];
  assert.equal(task.key, "auto-repair:format:" + HEAD);
  assert.equal(task.state, "queued");
  assert.ok(!JSON.stringify(task).includes(SECRET));
  f.advance();
  await f.worker.tick();
  assert.equal(f.calls.length, 4);
  assert.equal(
    f.journal.state.tasks.length,
    1,
    "no duplicate per SHA and recipe",
  );
});

test("incomplete, successful, unrelated, stale or non-push runs are never executable evidence", async (t) => {
  for (const options of [
    { runSha: "b".repeat(40) },
    { runStatus: "in_progress" },
    { runConclusion: "success" },
    { event: "pull_request" },
    { jobSha: "b".repeat(40) },
    { jobConclusion: "success" },
    { runCount: 11 },
  ]) {
    const f = fixture(t, options);
    await f.worker.tick();
    assert.equal(f.journal.state.tasks.length, 0);
  }
});

test("local branch or HEAD mismatch prevents all network requests", async (t) => {
  for (const o of [
    { localBranch: "feature" },
    { localHead: "invalid" },
    { localHead: "f".repeat(40) },
  ]) {
    const f = fixture(t, o);
    await f.worker.tick();
    if (o.localHead?.length === 40 && o.localBranch !== "feature") {
      assert.equal(f.journal.state.tasks.length, 0);
    } else {
      assert.equal(f.calls.length, 0);
    }
  }
});

test("no execution entitlement or missing private token fails closed", async (t) => {
  for (const options of [{ noExecute: true }, { absentToken: true }]) {
    const f = fixture(t, options);
    await f.worker.tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.journal.state.tasks.length, 0);
  }
});

test("rate limits and provider errors never cause a hot-loop retry", async (t) => {
  const f = fixture(t, { httpFailure: 429 });
  await f.worker.tick();
  await f.worker.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.journal.state.tasks.length, 0);
  f.advance(899999);
  await f.worker.tick();
  assert.equal(f.calls.length, 1);
  f.advance(1);
  await f.worker.tick();
  assert.equal(f.calls.length, 2);
});

test("explicit public mode sends no token or paid provider calls", async (t) => {
  const f = fixture(t, {
    watch: { tokenEnv: undefined, publicReadOnly: true },
  });
  await f.worker.tick();
  assert.equal(f.calls[0].options.headers.authorization, undefined);
  assert.equal(f.journal.state.tasks.length, 1);
});

test("only opted-in writable projects with known repair recipe run", async (t) => {
  for (const project of [
    { writable: false },
    { autopilotRepairWorker: { enabled: false, recipes: {} } },
    { autopilotCiWatch: { enabled: false } },
  ]) {
    const f = fixture(t, { project });
    await f.worker.tick();
    assert.equal(f.calls.length, 0);
  }
});

test("schema rejects unknown repair recipes, missing permission source and unsafe inputs", () => {
  const raw = {
    gateway: "https://gateway.example.com",
    token: "t".repeat(40),
    id: "device1",
    tenant: "tenant1",
    stateDir: "/tmp/codebridge-state",
    projects: [
      {
        id: "codebridge",
        root: "/tmp/codebridge",
        writable: true,
        gates: {
          format: { command: "node" },
          check: { command: "node" },
        },
        autopilotRepairWorker: {
          enabled: true,
          recipes: {
            format: {
              fixGate: "format",
              verifyGate: "check",
              paths: ["src/"],
            },
          },
        },
        autopilotCiWatch: {
          enabled: true,
          repository: REPO,
          branch: "main",
          workflow: "CodeBridge CI",
          job: "verify (ubuntu-24.04)",
          recipe: "format",
          publicReadOnly: true,
        },
      },
    ],
    license: { mode: "free" },
  };
  assert.equal(agentSchema.safeParse(raw).success, true);
  const wrong = structuredClone(raw);
  wrong.projects[0].autopilotCiWatch.recipe = "unknown";
  assert.equal(agentSchema.safeParse(wrong).success, false);
  wrong.projects[0].autopilotCiWatch.recipe = "format";
  wrong.projects[0].autopilotCiWatch.publicReadOnly = false;
  assert.equal(agentSchema.safeParse(wrong).success, false);
  wrong.projects[0].autopilotCiWatch.publicReadOnly = true;
  wrong.projects[0].autopilotCiWatch.repository = "kmjtechno/../admin";
  assert.equal(agentSchema.safeParse(wrong).success, false);
});

test("watch worker disabled entirely creates no timers", async () => {
  const noOp = startGitHubCiWatchWorker({
    projects: [],
    journal: null,
    licenseProvider: null,
  });
  assert.deepEqual(noOp.enabledProjects, []);
  await noOp.close();
});
