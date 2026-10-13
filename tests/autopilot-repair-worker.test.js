import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutopilotJournal } from "../src/autopilot.js";
import {
  IsolatedRepairWorker,
  parseRepairTask,
  startIsolatedRepairWorker,
  verifyRepairCandidate,
} from "../src/autopilot-repair-worker.js";
import { canQueueAutopilotGate } from "../src/autopilot-gate-worker.js";
import { WorktreeLanes } from "../src/worktree-lanes.js";
import { reviewRepairCandidate } from "../src/autopilot-repair-review.js";

function git(dir, ...args) {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(t, overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-isolated-fix-"));
  t.after(() =>
    fs.rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 50,
    }),
  );
  const root = path.join(base, "repo");
  const state = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  git(root, "init", "-q");
  git(root, "config", "user.name", "CI");
  git(root, "config", "user.email", "ci@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "format.js"), "const x=1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "do not change\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const head = git(root, "rev-parse", "HEAD");
  const journal = new AutopilotJournal(path.join(state, "autopilot"));
  const lanes = new WorktreeLanes(state);
  const jobs = new Map();
  const starts = [];
  const runner = {
    maxConcurrent: 1,
    capacity: () => ({
      blocked: Boolean(overrides.pressure),
      constrained: false,
      activeJobs: 0,
    }),
    run: (args) => {
      const id = "job-" + (starts.length + 1);
      const record = {
        id,
        project: args.project,
        state: "running",
        exitCode: null,
      };
      jobs.set(id, record);
      starts.push(args);
      return record;
    },
    get: (id) => jobs.get(id),
  };
  const project = {
    id: "repo",
    root,
    writable: true,
    gates: {
      format: { command: "node", args: ["format.js"], timeoutMs: 1000 },
      check: { command: "node", args: ["check.js"], timeoutMs: 1000 },
    },
    autopilotRepairWorker: {
      enabled: true,
      recipes: {
        format: { fixGate: "format", verifyGate: "check", paths: ["src/"] },
      },
    },
  };
  const worker = new IsolatedRepairWorker({
    projects: [project],
    journal,
    lanes,
    runner,
    licenseProvider: () => ({
      features: overrides.noExecute ? ["read", "write"] : ["execute"],
      limits: { concurrent_jobs: 1 },
    }),
  });
  const enqueue = (key = `auto-repair:format:${head}`) =>
    journal.enqueue({
      project: "repo",
      key,
      objective: "Format only src using approved gate",
    });
  return {
    base,
    root,
    head,
    state,
    journal,
    lanes,
    worker,
    runner,
    project,
    jobs,
    starts,
    enqueue,
  };
}

test("bounded task keys are eligible only for known recipes and exact SHAs", () => {
  const sha = "f".repeat(40);
  assert.deepEqual(
    parseRepairTask(`auto-repair:format:${sha}`, { format: {} }),
    { recipe: "format", expectedHead: sha },
  );
  assert.equal(
    parseRepairTask("auto-repair:format:main", { format: {} }),
    null,
  );
  assert.equal(
    parseRepairTask(`auto-repair:unknown:${sha}`, { format: {} }),
    null,
  );
  assert.equal(
    canQueueAutopilotGate(`auto-repair:format:${sha}`, ["write"]),
    false,
  );
  assert.equal(
    canQueueAutopilotGate(`auto-repair:format:${sha}`, ["write", "execute"]),
    true,
  );
});

test("24x7 worker prepares clean isolated lane without modifying dirty original", (t) => {
  const f = fixture(t);
  const preserved = path.join(f.root, "claude-untracked.txt");
  fs.writeFileSync(preserved, "preserve");
  const task = f.enqueue();
  f.worker.tick();
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].gate, "format");
  assert.notEqual(f.starts[0].cwd, f.root);
  assert.equal(fs.readFileSync(preserved, "utf8"), "preserve");
  assert.equal(f.journal.get(task.id, "repo").state, "running");
  assert.equal(
    f.journal.get(task.id, "repo").checkpoint.next,
    "REPAIR_MUTATION_MAY_HAVE_STARTED",
  );
});

test("approved edit runs a verification gate and preserves a review-only patch", (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  f.worker.tick();
  const lane = f.starts[0].cwd;
  fs.writeFileSync(path.join(lane, "src", "format.js"), "const x = 1;\n");
  f.jobs.get("job-1").state = "succeeded";
  f.jobs.get("job-1").exitCode = 0;
  f.worker.tick();
  assert.equal(f.starts.length, 2);
  assert.equal(f.starts[1].gate, "check");
  assert.equal(f.starts[1].cwd, lane);
  f.jobs.get("job-2").state = "succeeded";
  f.jobs.get("job-2").exitCode = 0;
  f.worker.tick();
  const result = f.journal.get(task.id, "repo");
  assert.equal(result.state, "waiting");
  assert.equal(result.lastReason, "VERIFIED_PATCH_AWAITING_REVIEW");
  assert.equal(result.checkpoint.next, "VERIFIED_PATCH_AWAITING_REVIEW");
  assert.match(result.checkpoint.summary, /format.js/);
  assert.equal(
    fs.readFileSync(path.join(f.root, "src", "format.js"), "utf8"),
    "const x=1;\n",
  );
  assert.equal(f.starts.length, 2);
  f.worker.tick();
  assert.equal(f.starts.length, 2, "no duplicate execution after waiting");

  const review = reviewRepairCandidate({
    project: f.project,
    journal: f.journal,
    lanes: f.lanes,
    taskId: task.id,
    includePatch: true,
  });
  assert.equal(review.publishStatus, "NOT_PUBLISHED");
  assert.equal(review.verificationJobId, "job-2");
  assert.match(review.patchSha256, /^[a-f0-9]{64}$/);
  assert.match(review.preview, /const x = 1/);
  assert.deepEqual(review.files, ["src/format.js"]);
  assert.equal(review.previewTruncated, false);

  // A verified worktree that changes after its gate is NOT the same review
  // candidate, even when it touches the same allowed file and byte count.
  fs.writeFileSync(path.join(lane, "src", "format.js"), "const y = 1;\n");
  assert.throws(
    () => reviewRepairCandidate({
      project: f.project,
      journal: f.journal,
      lanes: f.lanes,
      taskId: task.id,
    }),
    /AUTOPILOT_REPAIR_PATCH_CHANGED/,
  );
});

test("disallowed touched paths never run follow-up verification", (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  f.worker.tick();
  const lane = f.starts[0].cwd;
  fs.writeFileSync(path.join(lane, "README.md"), "FORBIDDEN\n");
  f.jobs.get("job-1").state = "succeeded";
  f.jobs.get("job-1").exitCode = 0;
  f.worker.tick();
  assert.equal(f.starts.length, 1);
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "ISOLATED_REPAIR_UNSAFE_OR_EMPTY_PATCH",
  );
});

test("untracked files and empty fixes never claim success", (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  f.worker.tick();
  fs.writeFileSync(path.join(f.starts[0].cwd, "src", "new.js"), "untracked");
  f.jobs.get("job-1").state = "succeeded";
  f.jobs.get("job-1").exitCode = 0;
  f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(f.starts.length, 1);
  assert.equal(verifyRepairCandidate(f.starts[0].cwd, ["src/"]), null);
});

test("failed fixing command does not run tests or loop forever", (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  f.worker.tick();
  f.jobs.get("job-1").state = "failed";
  f.jobs.get("job-1").exitCode = 1;
  f.worker.tick();
  f.worker.tick();
  assert.equal(f.starts.length, 1);
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "ISOLATED_FIX_FAILED_REVIEW_REQUIRED",
  );
});

test("failed verification never becomes a successful patch candidate", (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  f.worker.tick();
  fs.writeFileSync(
    path.join(f.starts[0].cwd, "src", "format.js"),
    "const x = 1;\n",
  );
  f.jobs.get("job-1").state = "succeeded";
  f.jobs.get("job-1").exitCode = 0;
  f.worker.tick();
  f.jobs.get("job-2").state = "failed";
  f.jobs.get("job-2").exitCode = 1;
  f.worker.tick();
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "ISOLATED_VERIFY_FAILED_REVIEW_REQUIRED",
  );
});

test("stale SHA, insufficient resources and absent execution rights fail closed", (t) => {
  const f = fixture(t, { noExecute: true });
  const task = f.enqueue();
  f.worker.tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.journal.get(task.id, "repo").state, "queued");
  const second = fixture(t);
  const mismatch = second.enqueue("auto-repair:format:" + "f".repeat(40));
  second.worker.tick();
  assert.equal(second.starts.length, 0);
  assert.equal(second.journal.get(mismatch.id, "repo").state, "waiting");
  const third = fixture(t, { pressure: true });
  const pressureTask = third.enqueue();
  third.worker.tick();
  assert.equal(third.starts.length, 0);
  assert.equal(third.journal.get(pressureTask.id, "repo").state, "queued");
});

test("restart with previous mutation checkpoint never repeats a fix", (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  f.worker.tick();
  const recovered = new AutopilotJournal(path.join(f.state, "autopilot"));
  const worker = new IsolatedRepairWorker({
    projects: [f.project],
    journal: recovered,
    lanes: f.lanes,
    runner: f.runner,
    licenseProvider: () => ({
      features: ["execute"],
      limits: { concurrent_jobs: 1 },
    }),
  });
  worker.tick();
  assert.equal(f.starts.length, 1);
  assert.equal(recovered.get(task.id, "repo").state, "waiting");
  assert.equal(
    recovered.get(task.id, "repo").lastReason,
    "PREVIOUS_ISOLATED_REPAIR_REQUIRES_REVIEW",
  );
});

test("unconfigured worker creates no background activity", async () => {
  const service = startIsolatedRepairWorker({
    projects: [],
    journal: null,
    runner: null,
    licenseProvider: null,
    lanes: null,
  });
  assert.deepEqual(service.enabledProjects, []);
  await service.close();
});

test("review action fails before a verified repair checkpoint", (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  assert.throws(
    () => reviewRepairCandidate({
      project: f.project,
      journal: f.journal,
      lanes: f.lanes,
      taskId: task.id,
      includePatch: true,
    }),
    /AUTOPILOT_REPAIR_NOT_VERIFIED/,
  );
});
