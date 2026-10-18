import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/tools.js";

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    windowsHide: true,
  }).trim();

test("queued quality gate is pinned to a clean detached lane until actual start", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-gate-lane-"));
  t.after(() =>
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }),
  );
  const root = path.join(temp, "repo");
  const stateDir = path.join(temp, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  git(root, "init", "-q");
  git(root, "config", "user.name", "KMJ QA");
  git(root, "config", "user.email", "qa@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "tracked.txt"), "pinned\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  const head = git(root, "rev-parse", "HEAD");

  // The fake runner records a queued job without executing any project code.
  const submitted = [];
  const runner = {
    maxConcurrent: 1,
    run: (spec) => {
      submitted.push(spec);
      return { id: "pending-gate-1", state: "queued", gate: spec.gate };
    },
  };
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir,
      projects: [
        {
          id: "p1",
          root,
          writable: true,
          gates: {
            audit: {
              command: process.execPath,
              args: ["--version"],
              timeoutMs: 10000,
            },
          },
          commands: {},
        },
      ],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
  );

  const lane = await dispatch(
    "worktree_lane_prepare",
    {
      device: "d1",
      project: "p1",
      laneId: "auditLane",
      expectedHead: head,
      approveLocalGitCheckout: true,
    },
    ["execute"],
  );
  assert.equal(lane.head, head);
  assert.notEqual(lane.path, root);
  assert.equal(git(lane.path, "status", "--porcelain"), "");

  const queued = await dispatch(
    "run_quality_gate",
    {
      device: "d1",
      project: "p1",
      gate: "audit",
      requestKey: "immutable-audit-lane",
      laneId: "auditLane",
    },
    ["execute"],
  );
  assert.equal(queued.state, "queued");
  assert.equal(submitted.length, 1);
  const job = submitted[0];
  assert.equal(job.cwd, lane.path);
  assert.equal(job.beforeStart(), lane.path);

  // A parallel chat's uncommitted edit is rejected before process start.
  const marker = path.join(lane.path, "local-edit.txt");
  fs.writeFileSync(marker, "DO_NOT_EXECUTE\n");
  assert.throws(() => job.beforeStart(), /WORKTREE_HAS_UNSAVED_WORK/);
  fs.unlinkSync(marker);
  assert.equal(job.beforeStart(), lane.path);

  // Even a *clean* different detached HEAD is rejected: the queue had
  // approved the original commit, not a future commit or moving branch.
  fs.writeFileSync(path.join(lane.path, "new-commit.txt"), "new\n");
  git(lane.path, "add", "new-commit.txt");
  git(lane.path, "commit", "-qm", "different candidate");
  assert.equal(git(lane.path, "status", "--porcelain"), "");
  assert.notEqual(git(lane.path, "rev-parse", "HEAD"), head);
  assert.throws(() => job.beforeStart(), /WORKTREE_HEAD_MISMATCH/);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), "pinned\n");
});
