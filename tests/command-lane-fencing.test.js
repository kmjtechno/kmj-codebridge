import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/tools.js";
import { WorktreeLanes } from "../src/worktree-lanes.js";
import { JobRunner } from "../src/jobs.js";

function fixture(t, laneId = "ci") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-command-fence-"));
  const root = path.join(base, "repo");
  const state = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(root, "tracked.txt"), "original");
  git("add", ".");
  git("commit", "-qm", "initial");
  const head = git("rev-parse", "HEAD");
  const lane = new WorktreeLanes(state).prepare("p1", root, laneId, head);
  const runner = new JobRunner(path.join(state, "jobs"));
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: state,
      projects: [
        {
          id: "p1",
          root,
          writable: true,
          commands: {
            main_platform_ui_ci: {
              category: "build",
              command: process.execPath,
              variants: {
                check: {
                  args: ["-e", "console.log('EXECUTED')"],
                  timeoutMs: 2000,
                },
              },
            },
          },
        },
      ],
    },
    runner,
    () => ({ features: ["execute"], limits: { concurrent_jobs: 1 } }),
  );
  const run = (extra = {}) =>
    dispatch(
      "run_project_command",
      {
        device: "d1",
        project: "p1",
        command: "main_platform_ui_ci",
        variant: "check",
        laneId,
        expectedHead: head,
        requestKey: "check",
        ...extra,
      },
      ["execute"],
    );
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  return { root, head, lane, runner, run };
}
async function finish(runner, job) {
  for (let n = 0; n < 150; n++) {
    const j = runner.get(job.id, "p1");
    if (!["queued", "running"].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("JOB_TIMEOUT");
}
test("frontend command requires an explicit expected SHA", async (t) => {
  const x = fixture(t);
  await assert.rejects(
    x.run({ expectedHead: undefined }),
    /WORKTREE_EXPECTED_HEAD_REQUIRED/,
  );
});
test("frontend command refuses a modified prepared lane", async (t) => {
  const x = fixture(t);
  fs.writeFileSync(path.join(x.lane.path, "tracked.txt"), "modified");
  await assert.rejects(x.run(), /WORKTREE_HAS_UNSAVED_WORK/);
});
test("frontend command refuses a moved prepared lane", async (t) => {
  const x = fixture(t);
  fs.writeFileSync(path.join(x.lane.path, "tracked.txt"), "new commit");
  execFileSync("git", ["add", "."], { cwd: x.lane.path });
  execFileSync("git", ["commit", "-qm", "moved"], { cwd: x.lane.path });
  await assert.rejects(x.run(), /WORKTREE_HEAD_MISMATCH/);
});
test("frontend command records the verified SHA and executes the fixed command", async (t) => {
  const x = fixture(t);
  const done = await finish(x.runner, await x.run());
  assert.equal(done.state, "succeeded");
  assert.equal(done.exitCode, 0);
  assert.match(done.output, /EXECUTED/);
  assert.ok(done.gate.endsWith(`@ci#${x.head}`));
});
test("queued frontend command rechecks lane before spawning", async (t) => {
  const x = fixture(t);
  x.runner.run({
    project: "p1",
    gate: "blocker",
    key: "blocker",
    cwd: x.root,
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{},350)"],
    timeoutMs: 2000,
  });
  const job = await x.run();
  assert.equal(job.state, "queued");
  fs.writeFileSync(
    path.join(x.lane.path, "tracked.txt"),
    "changed while queued",
  );
  const done = await finish(x.runner, job);
  assert.equal(done.state, "failed");
  assert.equal(done.exitCode, null);
  assert.doesNotMatch(done.output, /EXECUTED/);
  assert.match(done.output, /JOB_PRECONDITION_FAILED/);
});

test("maximum-length lane receipts remain readable after archival", async (t) => {
  const x = fixture(t, "a".repeat(48));
  const done = await finish(x.runner, await x.run());
  x.runner.archive.add(x.runner.jobs.get(done.id));
  const archived = x.runner.archive.get(done.id);
  assert.equal(archived.gate, done.gate);
  assert.ok(archived.gate.includes(x.head));
});

test("Calibration Pro QA auto-pins HEAD in one tool call without touching owner changes", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-calibration-auto-"));
  const root = path.join(home, "repo");
  const state = path.join(home, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "QA");
  git("config", "user.email", "qa@example.invalid");
  fs.writeFileSync(path.join(root, "tracked.txt"), "keep");
  git("add", ".");
  git("commit", "-qm", "exact-head baseline");
  const head = git("rev-parse", "HEAD");
  // A shared checkout can hold untracked owner work. It must not be cleaned.
  const dirty = path.join(root, "owner-private-notes.txt");
  fs.writeFileSync(dirty, "never delete me");

  const runner = new JobRunner(path.join(state, "jobs"));
  t.after(async () => {
    await runner.close();
    fs.rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const fixedProfile = {
    category: "build",
    command: process.execPath,
    variants: {
      full: {
        args: ["-e", "console.log('CALIBRATION_QA_EXECUTED=' + process.cwd())"],
        timeoutMs: 5000,
      },
    },
  };
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: state,
      projects: [
        {
          id: "kmj-calibration-pro",
          root,
          writable: true,
          commands: { calibration_v4_qa: fixedProfile },
        },
        {
          id: "kmj-calibration-studio",
          root,
          writable: true,
          commands: { calibration_v4_qa: fixedProfile },
        },
      ],
    },
    runner,
    () => ({ features: ["execute"], limits: { concurrent_jobs: 1 } }),
  );

  const projectCommand = (project, requestKey) =>
    dispatch(
      "run_project_command",
      {
        device: "d1",
        project,
        command: "calibration_v4_qa",
        variant: "full",
        requestKey,
      },
      ["execute"],
    );
  await assert.rejects(
    projectCommand("kmj-calibration-studio", "wrong-project"),
    /WORKTREE_LANE_REQUIRED/,
  );
  const job = await projectCommand("kmj-calibration-pro", "qa-current-head");
  let result;
  for (let i = 0; i < 150; i++) {
    result = runner.get(job.id, "kmj-calibration-pro");
    if (!["queued", "running"].includes(result.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(result.state, "succeeded");
  assert.equal(result.exitCode, 0);
  assert.ok(result.gate.endsWith("#" + head));
  assert.match(result.gate, /calibration_v4_qa_/);
  assert.match(result.output, /CALIBRATION_QA_EXECUTED=/);
  const lanes = new WorktreeLanes(state).status("kmj-calibration-pro", root).lanes;
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].head, head);
  assert.equal(lanes[0].dirty, false);
  assert.ok(result.output.includes(lanes[0].path));
  assert.notEqual(lanes[0].path, root);
  assert.equal(fs.readFileSync(dirty, "utf8"), "never delete me");
  assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), "keep");
  assert.equal(git("rev-parse", "HEAD"), head);
});
