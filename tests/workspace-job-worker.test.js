import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JobRunner } from "../src/jobs.js";
import { agentSchema } from "../src/config.js";
import {
  WorkspaceJobWorker,
  startWorkspaceJobWorker,
} from "../src/workspace-job-worker.js";

const CREDENTIAL = "device-credential-".padEnd(48, "c");
const ULID = "01JBZ0000000000000000000A0";
const TOKEN = "ab".repeat(24);
const shortSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.min(ms, 15)));

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function fixture(
  t,
  { dirty = false, gateScript = "process.exit(0)" } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wsjob-"));
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.test");
  git(root, "config", "user.name", "t");
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  if (dirty) fs.writeFileSync(path.join(root, "b.txt"), "b");
  const counter = path.join(dir, "runs.txt");
  const runner = new JobRunner(path.join(dir, "jobs"), {
    archiveMaxEntries: 50,
  });
  const server = {
    claims: [],
    reports: [],
    claimRequests: 0,
    claimStatus: 200,
    reportStatus: () => 200,
    headers: [],
  };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      server.headers.push({
        url: req.url,
        auth: req.headers.authorization,
        claim: req.headers["x-kmj-claim"],
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/codebridge/v1/jobs/claim") {
        server.claimRequests += 1;
        res.statusCode = server.claimStatus;
        return res.end(JSON.stringify({ job: server.claims.shift() ?? null }));
      }
      const parsed = JSON.parse(body || "{}");
      server.reports.push({ url: req.url, body: parsed });
      const status = server.reportStatus(parsed, server.reports.length);
      if (status === "drop") return req.socket.destroy();
      res.statusCode = status;
      res.end(
        JSON.stringify(
          status === 200
            ? { status: parsed.kind }
            : { error: "job_not_active" },
        ),
      );
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await runner.close();
    await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const project = {
    id: "proj",
    root,
    writable: true,
    gates: {
      fast: {
        command: process.execPath,
        args: [
          "-e",
          `require('fs').appendFileSync(${JSON.stringify(counter)},'x\\n');${gateScript}`,
        ],
        timeoutMs: 20000,
      },
      other: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 20000,
      },
    },
    workspaceJobs: {
      enabled: true,
      tools: ["git_status", "inspect_project", "quality_gate"],
      gates: ["fast"],
      requireCleanCheckout: true,
    },
  };
  const statuses = [];
  let offset = 0;
  const t0 = Date.now();
  const clockNow = () => t0 + offset + (Date.now() - t0);
  const make = (overrides = {}) =>
    new WorkspaceJobWorker({
      origin: `http://127.0.0.1:${srv.address().port}/`,
      credential: CREDENTIAL,
      projects: [project],
      runner,
      licenseProvider: () => ({ features: ["read", "write", "execute"] }),
      sleep: shortSleep,
      now: clockNow,
      pollMs: 20,
      heartbeatMs: 40,
      onStatus: (code) => statuses.push(code),
      ...overrides,
    });
  const job = (overrides = {}) => ({
    id: ULID,
    tool: "git_status",
    arguments: {},
    project_id: "proj",
    lease_expires_at: new Date(clockNow() + 120_000).toISOString(),
    claim_token: TOKEN,
    ...overrides,
  });
  const runs = () =>
    fs.existsSync(counter)
      ? fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length
      : 0;
  return {
    server,
    project,
    runner,
    make,
    job,
    statuses,
    runs,
    root,
    advance: (ms) => (offset += ms),
  };
}

test("read-only tools and an approved gate run end to end with real claim/report calls", async (t) => {
  const f = await fixture(t);
  const worker = f.make();
  f.server.claims.push(f.job());
  await worker.tick();
  f.server.claims.push(
    f.job({ id: "01JBZ0000000000000000000A1", tool: "inspect_project" }),
  );
  await worker.tick();
  f.server.claims.push(
    f.job({
      id: "01JBZ0000000000000000000A2",
      tool: "quality_gate",
      arguments: { gate: "fast" },
    }),
  );
  await worker.tick();

  const kinds = f.server.reports.map(
    (r) => `${r.url.split("/")[5]}:${r.body.kind}`,
  );
  assert.deepEqual(
    kinds.filter((k) => !k.endsWith(":progress")),
    [
      `${ULID}:started`,
      `${ULID}:succeeded`,
      "01JBZ0000000000000000000A1:started",
      "01JBZ0000000000000000000A1:succeeded",
      "01JBZ0000000000000000000A2:started",
      "01JBZ0000000000000000000A2:succeeded",
    ],
  );
  const head = git(f.root, "rev-parse", "HEAD").trim();
  const gitDone = f.server.reports.find((r) => r.body.kind === "succeeded");
  assert.match(gitDone.body.summary, /Branch main; 0 changed path\(s\)/);
  assert.equal(gitDone.body.evidence.commit_sha, head);
  const gateDone = f.server.reports.at(-1).body;
  assert.equal(gateDone.evidence.result, "pass");
  assert.equal(gateDone.evidence.exit_code, 0);
  assert.equal(gateDone.evidence.gate, "fast");
  assert.equal(f.runs(), 1);
  // Every call used the bearer credential; reports carried the claim token only as a header.
  assert.ok(f.server.headers.every((h) => h.auth === `Bearer ${CREDENTIAL}`));
  assert.ok(
    f.server.headers
      .filter((h) => h.url.includes("/events"))
      .every((h) => h.claim === TOKEN),
  );
  const payloads = JSON.stringify([f.server.reports, f.statuses]);
  assert.equal(payloads.includes(CREDENTIAL), false);
  assert.equal(payloads.includes(TOKEN), false);
});

test("a failing gate reports failure with only an exit code, never output", async (t) => {
  const f = await fixture(t, {
    gateScript: "console.error('SECRET-OUTPUT');process.exit(3)",
  });
  f.server.claims.push(
    f.job({ tool: "quality_gate", arguments: { gate: "fast" } }),
  );
  await f.make().tick();
  const done = f.server.reports.at(-1).body;
  assert.equal(done.kind, "failed");
  assert.equal(done.evidence.result, "fail");
  assert.equal(done.evidence.exit_code, 3);
  assert.equal(
    JSON.stringify(f.server.reports).includes("SECRET-OUTPUT"),
    false,
  );
});

test("unconfigured, unlisted, wrong-project and locally disabled requests never execute", async (t) => {
  const f = await fixture(t);
  const worker = f.make();
  const cases = [
    [
      { tool: "quality_gate", arguments: { gate: "other" } },
      "GATE_NOT_ALLOWED",
    ],
    [
      { tool: "quality_gate", arguments: { gate: "missing" } },
      "GATE_NOT_ALLOWED",
    ],
    [
      { tool: "quality_gate", arguments: { gate: "fast", cmd: "rm -rf /" } },
      "ARGUMENTS_INVALID",
    ],
    [
      { tool: "quality_gate", arguments: { gate: "../x" } },
      "ARGUMENTS_INVALID",
    ],
    [{ tool: "git_status", arguments: { path: "/etc" } }, "ARGUMENTS_INVALID"],
    [{ tool: "run_shell", arguments: {} }, "TOOL_NOT_ALLOWED"],
    [{ project_id: "other-project" }, "PROJECT_NOT_ENABLED"],
  ];
  for (const [overrides] of cases) {
    f.server.claims.push(f.job(overrides));
    await worker.tick();
  }
  const refusals = f.server.reports
    .filter((r) => r.body.kind === "failed")
    .map((r) => r.body.detail);
  assert.deepEqual(
    refusals,
    cases.map(([, code]) => code),
  );
  assert.equal(
    f.server.reports.some((r) => r.body.kind === "started"),
    false,
  );
  assert.equal(f.runs(), 0);

  f.project.workspaceJobs.tools = ["git_status"];
  f.server.claims.push(
    f.job({ tool: "quality_gate", arguments: { gate: "fast" } }),
  );
  await worker.tick();
  assert.equal(f.server.reports.at(-1).body.detail, "TOOL_NOT_ENABLED_LOCALLY");
  assert.equal(f.runs(), 0);

  f.project.workspaceJobs.tools = ["git_status", "quality_gate"];
  f.project.writable = false;
  f.server.claims.push(
    f.job({ tool: "quality_gate", arguments: { gate: "fast" } }),
  );
  await worker.tick();
  assert.equal(f.server.reports.at(-1).body.detail, "READ_ONLY_PROJECT");
  assert.equal(f.runs(), 0);
});

test("revoked license grants and dirty checkouts refuse before running", async (t) => {
  const f = await fixture(t, { dirty: true });
  f.server.claims.push(
    f.job({ tool: "quality_gate", arguments: { gate: "fast" } }),
  );
  await f.make().tick();
  assert.equal(f.server.reports.at(-1).body.detail, "WORKTREE_DIRTY");
  assert.equal(f.runs(), 0);

  f.server.claims.push(f.job());
  await f
    .make({
      licenseProvider: () => {
        throw new Error("LICENSE_REPLAY");
      },
    })
    .tick();
  assert.equal(f.server.reports.at(-1).body.detail, "LICENSE_NOT_ACTIVE");
  f.server.claims.push(f.job());
  await f.make({ licenseProvider: () => ({ features: ["read"] }) }).tick();
  assert.equal(f.server.reports.at(-1).body.kind, "succeeded");
  f.server.claims.push(
    f.job({ tool: "quality_gate", arguments: { gate: "fast" } }),
  );
  await f.make({ licenseProvider: () => ({ features: ["read"] }) }).tick();
  assert.equal(f.server.reports.at(-1).body.detail, "LICENSE_NOT_ACTIVE");
});

test("malformed jobs are dropped or refused without running anything", async (t) => {
  const f = await fixture(t);
  const worker = f.make();
  f.server.claims.push({ id: ULID });
  f.server.claims.push("nope");
  f.server.claims.push(f.job({ claim_token: "short" }));
  f.server.claims.push({ ...f.job(), extra: "x" });
  f.server.claims.push(f.job({ id: "not-a-ulid" }));
  for (let i = 0; i < 5; i += 1) await worker.tick();
  assert.equal(f.server.reports.length, 1); // only the one with a parseable id and token (extra key)
  assert.equal(f.server.reports[0].body.detail, "MALFORMED_JOB");
  assert.equal(f.runs(), 0);
});

test("lease problems and clock drift refuse the job", async (t) => {
  const f = await fixture(t);
  const worker = f.make();
  f.server.claims.push(
    f.job({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() }),
  );
  await worker.tick();
  f.server.claims.push(
    f.job({ lease_expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
  );
  await worker.tick();
  f.server.claims.push(f.job({ lease_expires_at: "not a date" }));
  await worker.tick();
  assert.deepEqual(
    f.server.reports.map((r) => r.body.detail),
    ["LEASE_INVALID", "LEASE_INVALID", "LEASE_INVALID"],
  );
});

test("auth failures, a disabled server and outages back off and stop polling", async (t) => {
  const f = await fixture(t);
  let clock = 1_000_000;
  const worker = f.make({ now: () => clock });
  f.server.claimStatus = 401;
  await worker.tick();
  await worker.tick();
  assert.equal(
    f.server.claimRequests,
    1,
    "no hammering after a rejected credential",
  );
  assert.deepEqual(f.statuses, ["WORKSPACE_JOBS_CREDENTIAL_REJECTED"]);
  clock += 301_000;
  f.server.claimStatus = 503;
  await worker.tick();
  assert.equal(f.server.claimRequests, 2);
  assert.equal(f.statuses.at(-1), "WORKSPACE_JOBS_DISABLED_BY_SERVER");
  clock += 59_000;
  await worker.tick();
  assert.equal(f.server.claimRequests, 2, "still backing off");
  clock += 61_000 * 3;
  f.server.claimStatus = 200;
  await worker.tick();
  assert.equal(f.server.claimRequests, 3);
});

test("a cancelled or expired job stops immediately and the local run is cancelled", async (t) => {
  const f = await fixture(t, { gateScript: "setTimeout(()=>{},15000)" });
  f.server.reportStatus = (body) => (body.kind === "progress" ? 409 : 200);
  f.server.claims.push(
    f.job({ tool: "quality_gate", arguments: { gate: "fast" } }),
  );
  await f.make().tick();
  const kinds = f.server.reports.map((r) => r.body.kind);
  assert.deepEqual(kinds, ["started", "progress"]);
  assert.equal(kinds.includes("succeeded"), false);
  const id = [...f.runner.jobs.values()][0].id;
  // The local process is told to stop; wait for the runner to observe the exit.
  const deadline = Date.now() + 5000;
  while (f.runner.get(id, "proj").state === "running" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.notEqual(f.runner.get(id, "proj").state, "running");
});

test("a rejected start (already claimed elsewhere or cancelled) runs nothing", async (t) => {
  const f = await fixture(t);
  f.server.reportStatus = () => 409;
  f.server.claims.push(
    f.job({ tool: "quality_gate", arguments: { gate: "fast" } }),
  );
  await f.make().tick();
  assert.equal(f.runs(), 0);
  assert.equal(f.server.reports.length, 1);
});

test("a duplicate offer of the same job id never executes the gate twice", async (t) => {
  const f = await fixture(t);
  const worker = f.make();
  const offer = f.job({ tool: "quality_gate", arguments: { gate: "fast" } });
  f.server.claims.push(offer, offer);
  await worker.tick();
  await worker.tick();
  assert.equal(f.runs(), 1);
});

test("a network partition during reporting is bounded and never throws", async (t) => {
  const f = await fixture(t);
  f.server.reportStatus = () => "drop";
  f.server.claims.push(f.job());
  await f.make().tick();
  assert.ok(
    f.server.reports.length >= 1 && f.server.reports.length <= 6,
    "bounded retries on started",
  );
  assert.equal(f.statuses.includes("START_NOT_ACCEPTED"), true);

  const g = await fixture(t);
  g.server.claims.push(g.job());
  const worker = g.make({ origin: "http://127.0.0.1:1/" });
  await worker.tick();
  assert.deepEqual(g.statuses, ["WORKSPACE_JOBS_NETWORK"]);
});

test("disabled projects create no worker, timer or request", async (t) => {
  const f = await fixture(t);
  f.project.workspaceJobs.enabled = false;
  const handle = startWorkspaceJobWorker({
    projects: [f.project],
    runner: f.runner,
    licenseProvider: () => ({}),
    origin: `http://127.0.0.1:${1}/`,
    credential: CREDENTIAL,
  });
  assert.deepEqual(handle.enabledProjects, []);
  assert.equal(handle.isIdle(), true);
  await handle.close();
  const none = startWorkspaceJobWorker({
    projects: [f.project],
    origin: null,
    credential: null,
  });
  assert.deepEqual(none.enabledProjects, []);
  assert.equal(f.server.claimRequests, 0);
});

test("constructor rejects unsafe origins and short credentials", async (t) => {
  const f = await fixture(t);
  for (const origin of [
    "http://example.com/",
    "https://u:p@example.com/",
    "https://example.com/path",
    "https://example.com/?x=1",
    "ftp://example.com/",
  ])
    assert.throws(() => f.make({ origin }), /ORIGIN_INVALID/);
  assert.throws(() => f.make({ credential: "short" }), /CREDENTIAL_INVALID/);
});

test("config requires configured gates and a writable project for quality_gate", () => {
  const base = {
    gateway: "https://gateway.example.com/",
    token: "t".repeat(40),
    id: "dev1",
    tenant: "tenant1",
    stateDir: "/tmp/state",
    license: { mode: "free" },
  };
  const project = (workspaceJobs, extra = {}) => ({
    ...base,
    projects: [
      {
        id: "p1",
        root: "/tmp/p1",
        writable: true,
        gates: { fast: { command: "node", args: ["-v"] } },
        ...extra,
        workspaceJobs,
      },
    ],
  });
  assert.equal(
    agentSchema.safeParse(project({ enabled: true, tools: ["git_status"] }))
      .success,
    true,
  );
  assert.equal(
    agentSchema.safeParse(
      project({ enabled: true, tools: ["quality_gate"], gates: ["fast"] }),
    ).success,
    true,
  );
  assert.equal(
    agentSchema.safeParse(
      project({ enabled: true, tools: ["quality_gate"], gates: [] }),
    ).success,
    false,
  );
  assert.equal(
    agentSchema.safeParse(
      project({ enabled: true, tools: ["quality_gate"], gates: ["nope"] }),
    ).success,
    false,
  );
  assert.equal(
    agentSchema.safeParse(
      project(
        { enabled: true, tools: ["quality_gate"], gates: ["fast"] },
        { writable: false },
      ),
    ).success,
    false,
  );
  assert.equal(
    agentSchema.safeParse(project({ enabled: true, tools: ["shell"] })).success,
    false,
  );
  assert.equal(
    agentSchema.safeParse(
      project({ enabled: true, tools: ["git_status"], extra: 1 }),
    ).success,
    false,
  );
  const absent = agentSchema.parse({
    ...base,
    projects: [{ id: "p1", root: "/tmp/p1", writable: false }],
  });
  assert.equal(absent.projects[0].workspaceJobs, undefined);
});
