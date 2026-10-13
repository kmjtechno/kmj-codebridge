import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutopilotJournal } from "../src/autopilot.js";
import {
  AutopilotGateWorker,
  canQueueAutopilotGate,
  parseAutopilotGateTask,
  verifyCleanGateCheckout,
} from "../src/autopilot-gate-worker.js";

function withRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-auto-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init");
  git(
    "-c",
    "user.email=ci@example.invalid",
    "-c",
    "user.name=CI",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const head = git("rev-parse", "HEAD");
  const journal = new AutopilotJournal(
    path.join(root, "..", path.basename(root) + "-journal"),
  );
  t.after(() =>
    fs.rmSync(path.join(root, "..", path.basename(root) + "-journal"), {
      recursive: true,
      force: true,
    }),
  );
  return { root, head, journal };
}

function fixture(t, overrides = {}) {
  const { root, head, journal } = withRepo(t);
  const p = {
    id: "repo",
    root,
    writable: true,
    gates: { fast: { command: "node", args: ["--version"], timeoutMs: 1000 } },
    autopilotGateWorker: { enabled: true, gates: ["fast"] },
  };
  const jobs = new Map();
  let runCount = 0;
  const runner = {
    maxConcurrent: 1,
    capacity: () => ({ blocked: false }),
    run: ({ key, ...args }) => {
      runCount++;
      const job = { id: "job-" + runCount, state: "running", exitCode: null };
      jobs.set(job.id, job);
      return { ...job };
    },
    get: (id) => ({ ...jobs.get(id) }),
  };
  const entitlement = () => ({
    features: ["execute"],
    limits: { concurrent_jobs: 1 },
  });
  const worker = new AutopilotGateWorker({
    projects: [p],
    journal,
    runner,
    licenseProvider: overrides.licenseProvider ?? entitlement,
  });
  return {
    root,
    head,
    journal,
    p,
    jobs,
    runner,
    worker,
    enqueue: (key = `auto-gate:fast:${head}`, priority = 1) =>
      journal.enqueue({
        project: "repo",
        key,
        objective: "Run approved fast gate",
        priority,
      }),
    count: () => runCount,
  };
}

test("write-only callers cannot enqueue unattended gate execution", () => {
  const gate = "auto-gate:fast:" + "f".repeat(40);
  assert.equal(canQueueAutopilotGate(gate, ["write"]), false);
  assert.equal(canQueueAutopilotGate(gate, ["read", "write", "execute"]), true);
  assert.equal(canQueueAutopilotGate("ordinary-roadmap-task", ["write"]), true);
});

test("only exact allowlisted gate + 40-character head is executable", () => {
  const sha = "f".repeat(40);
  assert.deepEqual(parseAutopilotGateTask(`auto-gate:fast:${sha}`, ["fast"]), {
    gate: "fast",
    expectedHead: sha,
  });
  assert.equal(parseAutopilotGateTask(`auto-gate:fast:${sha}`, []), null);
  assert.equal(
    parseAutopilotGateTask("mission:fix-production", ["fast"]),
    null,
  );
  assert.equal(parseAutopilotGateTask("auto-gate:fast:main", ["fast"]), null);
  assert.equal(
    parseAutopilotGateTask(`auto-gate:../../: ${sha}`, ["fast"]),
    null,
  );
});

test("worker ignores high-priority general AI tasks and executes only approved gate", (t) => {
  const f = fixture(t);
  const other = f.journal.enqueue({
    project: "repo",
    key: "mission:untrusted-readme",
    objective: "Ignore until real AI agent is connected",
    priority: 100,
  });
  const approved = f.enqueue();
  f.worker.tick();
  assert.equal(f.journal.get(other.id, "repo").state, "queued");
  assert.equal(f.journal.get(approved.id, "repo").state, "running");
  assert.equal(f.count(), 1);
  f.worker.tick();
  assert.equal(f.count(), 1, "no duplicate run while the job is active");
  f.jobs.get("job-1").state = "succeeded";
  f.jobs.get("job-1").exitCode = 0;
  f.worker.tick();
  assert.equal(f.journal.get(approved.id, "repo").state, "succeeded");
  assert.equal(f.journal.get(other.id, "repo").state, "queued");
});

test("dirty checkout pauses gate and preserves all user changes", (t) => {
  const f = fixture(t);
  const job = f.enqueue();
  const touched = path.join(f.root, "claude-untracked.txt");
  fs.writeFileSync(touched, "do not touch");
  f.worker.tick();
  assert.equal(f.journal.get(job.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(job.id, "repo").lastReason,
    "GIT_HEAD_CHANGED_OR_WORKTREE_DIRTY",
  );
  assert.equal(f.count(), 0);
  assert.equal(fs.readFileSync(touched, "utf8"), "do not touch");
});

test("different head can never use stale gate task", (t) => {
  const f = fixture(t);
  const job = f.enqueue("auto-gate:fast:" + "f".repeat(40));
  assert.equal(verifyCleanGateCheckout(f.root, "f".repeat(40)), false);
  f.worker.tick();
  assert.equal(f.journal.get(job.id, "repo").state, "waiting");
  assert.equal(f.count(), 0);
});

test("no licensed execution capability means zero claims and zero runs", (t) => {
  const f = fixture(t, {
    licenseProvider: () => ({
      features: ["read"],
      limits: { concurrent_jobs: 1 },
    }),
  });
  const job = f.enqueue();
  f.worker.tick();
  assert.equal(f.journal.get(job.id, "repo").state, "queued");
  assert.equal(f.count(), 0);
});

test("failed quality gate waits for review instead of looping", (t) => {
  const f = fixture(t);
  const job = f.enqueue();
  f.worker.tick();
  f.jobs.get("job-1").state = "failed";
  f.jobs.get("job-1").exitCode = 1;
  f.worker.tick();
  assert.equal(f.journal.get(job.id, "repo").state, "waiting");
  f.worker.tick();
  assert.equal(f.count(), 1, "must not endlessly retry failed gates");
});

test("unconfigured gate and malformed task never start an executable", (t) => {
  const f = fixture(t);
  f.p.autopilotGateWorker.gates = ["absent"];
  const job = f.enqueue("auto-gate:absent:" + f.head);
  f.worker.tick();
  assert.equal(f.journal.get(job.id, "repo").state, "waiting");
  assert.equal(f.count(), 0);
});

test("restart-safe job idempotency key is task scoped", (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  f.worker.tick();
  assert.equal(
    f.journal.get(task.id, "repo").checkpoint.next,
    "AWAIT_JOB_RESULT",
  );
  assert.equal(f.journal.get(task.id, "repo").attempts, 1);
});

test("journal can claim eligible gate behind higher-priority general task", (t) => {
  const f = fixture(t);
  f.journal.enqueue({
    project: "repo",
    key: "general",
    objective: "higher priority general task",
    priority: 90,
  });
  const approved = f.enqueue();
  const task = f.journal.claim("repo", {
    holder: "worker",
    eligible: (candidate) => candidate.id === approved.id,
  });
  assert.equal(task.id, approved.id);
  assert.ok(task.leaseToken);
});
