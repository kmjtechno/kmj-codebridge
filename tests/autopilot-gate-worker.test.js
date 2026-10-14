import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutopilotJournal } from "../src/autopilot.js";
import { WorktreeLanes } from "../src/worktree-lanes.js";
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
    autopilotGateWorker: {
      enabled: true,
      gates: ["fast"],
      isolatedWorktree: overrides.isolatedWorktree === true,
    },
  };
  const jobs = new Map();
  let runCount = 0;
  let lastRun = null;
  const runner = {
    maxConcurrent: 1,
    capacity: () => ({ blocked: false }),
    run: ({ key, ...args }) => {
      runCount++;
      lastRun = { key, ...args };
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
    lanes:
      overrides.lanes === false
        ? null
        : new WorktreeLanes(journal.dir),
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
    lastRun: () => lastRun,
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

test("owner-approved failed gate enqueues exactly one SHA-pinned isolated repair", (t) => {
  const f = fixture(t);
  f.p.autopilotRepairWorker = {
    enabled: true,
    recipes: {
      format: {
        triggerGate: "fast",
        fixGate: "formatter",
        verifyGate: "fast",
        paths: ["src/"],
      },
    },
  };
  const task = f.enqueue();
  f.worker.tick();
  f.jobs.get("job-1").state = "failed";
  f.jobs.get("job-1").exitCode = 1;
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  const repair = f.journal.state.tasks.filter(
    (item) => item.key === `auto-repair:format:${f.head}`,
  );
  assert.equal(repair.length, 1);
  assert.equal(repair[0].state, "queued");
  f.worker.tick();
  assert.equal(
    f.journal.state.tasks.filter(
      (item) => item.key === `auto-repair:format:${f.head}`,
    ).length,
    1,
  );
});

test("failed gate cannot schedule repairs unless explicitly configured", (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  f.worker.tick();
  f.jobs.get("job-1").state = "failed";
  f.jobs.get("job-1").exitCode = 1;
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(f.journal.state.tasks.length, 1);
});

test("isolated gate executes at pinned SHA despite Claude dirty checkout", (t) => {
  const f = fixture(t, { isolatedWorktree: true });
  const local = path.join(f.root, "claude-untracked.txt");
  fs.writeFileSync(local, "preserve parallel AI edits");
  const task = f.enqueue();
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "running");
  assert.equal(f.count(), 1);
  const selected = f.lastRun().cwd;
  assert.notEqual(selected, f.root, "QA must not execute in Claude's checkout");
  assert.ok(selected.includes("isolated-worktrees"));
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: selected,
      encoding: "utf8",
    }).trim(),
    f.head,
  );
  assert.equal(
    fs.readFileSync(local, "utf8"),
    "preserve parallel AI edits",
  );
  f.jobs.get("job-1").state = "succeeded";
  f.jobs.get("job-1").exitCode = 0;
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "succeeded");
  assert.equal(fs.readFileSync(local, "utf8"), "preserve parallel AI edits");
});

test("dirty isolated worktree remains reviewable and never runs a gate", (t) => {
  const f = fixture(t, { isolatedWorktree: true });
  const lanes = new WorktreeLanes(f.journal.dir);
  const row = lanes.prepare(
    "repo",
    f.root,
    `autogate_${f.head.slice(0, 24)}`,
    f.head,
  );
  const artifact = path.join(row.path, "review-evidence.txt");
  fs.writeFileSync(artifact, "do not delete test artifacts");
  const task = f.enqueue();
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "ISOLATED_GATE_WORKTREE_DIRTY_REVIEW_REQUIRED",
  );
  assert.equal(f.count(), 0);
  assert.equal(fs.readFileSync(artifact, "utf8"), "do not delete test artifacts");
});

test("isolated opt-in without a worktree manager fails closed, never runs root", (t) => {
  const f = fixture(t, { isolatedWorktree: true, lanes: false });
  const task = f.enqueue();
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "ISOLATED_GATE_WORKTREE_UNAVAILABLE",
  );
  assert.equal(f.count(), 0);
});

test("isolated lane refuses an outdated expected HEAD and preserves dirty data", (t) => {
  const f = fixture(t, { isolatedWorktree: true });
  const before = path.join(f.root, "other-agent.tmp");
  fs.writeFileSync(before, "keep it");
  const task = f.enqueue("auto-gate:fast:" + "f".repeat(40));
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(f.count(), 0);
  assert.equal(fs.readFileSync(before, "utf8"), "keep it");
});

test("isolated mode obeys finite capacity and never starts a gate under pressure", (t) => {
  const f = fixture(t, { isolatedWorktree: true });
  const task = f.enqueue();
  f.runner.capacity = () => ({ blocked: true });
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "queued");
  assert.equal(f.count(), 0);
});

test("execution entitlement still fences worktree creation in isolated mode", (t) => {
  const f = fixture(t, {
    isolatedWorktree: true,
    licenseProvider: () => ({
      features: ["read", "write"],
      limits: { concurrent_jobs: 1 },
    }),
  });
  const task = f.enqueue();
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "queued");
  assert.equal(f.count(), 0);
  assert.equal(
    new WorktreeLanes(f.journal.dir).status("repo", f.root).lanes.length,
    0,
  );
});
