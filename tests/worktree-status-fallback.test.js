import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeLanes } from "../src/worktree-lanes.js";
import { createDispatcher } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  }).trim();
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lane-status-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  const state = path.join(base, "private");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  git(root, "init", "-q");
  git(root, "config", "user.name", "KMJ Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "README.md"), "synthetic fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "test");
  const runner = new JobRunner(path.join(base, "jobs"));
  t.after(async () => runner.close());
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir: state,
      projects: [
        { id: "project1", root, writable: true, gates: {}, commands: {} },
      ],
    },
    runner,
    () => ({ features: ["read", "execute"], limits: { concurrent_jobs: 1 } }),
  );
  return {
    root,
    state,
    head: git(root, "rev-parse", "HEAD"),
    lanes: new WorktreeLanes(state),
    dispatch,
    scope: { device: "device1", project: "project1" },
  };
}

test("healthy worktree status keeps normal contract, no fallback marker", async (t) => {
  const f = fixture(t);
  const lane = f.lanes.prepare("project1", f.root, "healthy", f.head);
  const status = await f.dispatch("worktree_lane_status", f.scope, ["read"]);
  assert.equal(status.noAdditionalExecutionSlots, true);
  assert.equal(status.diagnosticOnly, undefined);
  assert.deepEqual(
    status.lanes.map((item) => item.laneId),
    ["healthy"],
  );
  assert.equal(status.lanes[0].dirty, false);
  assert.equal(status.lanes[0].head, f.head);
  assert.equal(
    fs.readFileSync(path.join(lane.path, "README.md"), "utf8"),
    "synthetic fixture\n",
  );
});

test("broken lane status fails closed into read-only per-lane inventory", async (t) => {
  const f = fixture(t);
  const dirty = f.lanes.prepare("project1", f.root, "dirtyOwner", f.head);
  const damaged = f.lanes.prepare("project1", f.root, "damaged", f.head);
  const ownerFile = path.join(dirty.path, "PRESERVE.txt");
  fs.writeFileSync(ownerFile, "KEEP OWNER FILE");
  fs.renameSync(
    path.join(damaged.path, ".git"),
    path.join(damaged.path, ".git.disabled"),
  );
  const status = await f.dispatch("worktree_lane_status", f.scope, ["read"]);
  assert.equal(status.statusError, "WORKTREE_GIT_FAILED");
  assert.equal(status.status, "REVIEW_REQUIRED");
  assert.equal(status.diagnosticOnly, true);
  assert.equal(status.mayPrepare, false);
  assert.equal(status.cleanupPerformed, false);
  assert.equal(status.productionMutation, false);
  assert.equal(status.noAdditionalExecutionSlots, true);
  assert.deepEqual(
    status.lanes.map(({ laneId, status: code }) => [laneId, code]),
    [
      ["damaged", "LANE_GIT_LINK_INVALID_REVIEW_REQUIRED"],
      ["dirtyOwner", "INSPECTED"],
    ],
  );
  assert.equal(status.lanes[1].dirty, true);
  assert.equal(fs.readFileSync(ownerFile, "utf8"), "KEEP OWNER FILE");
  assert.equal(fs.existsSync(path.join(damaged.path, ".git.disabled")), true);
  assert.equal(JSON.stringify(status).includes(f.root), false);
  assert.equal(JSON.stringify(status).includes(f.state), false);
});

test("unsafe private lane name yields a categorical review result without cleanup", async (t) => {
  const f = fixture(t);
  f.lanes.prepare("project1", f.root, "known", f.head);
  const unsafe = path.join(
    f.state,
    "isolated-worktrees",
    "project1",
    "invalid+name",
  );
  fs.mkdirSync(unsafe);
  const status = await f.dispatch("worktree_lane_status", f.scope, ["read"]);
  assert.equal(status.statusError, "WORKTREE_PATH_UNSAFE");
  assert.equal(status.status, "REVIEW_REQUIRED");
  assert.equal(status.mayPrepare, false);
  assert.equal(status.cleanupPerformed, false);
  assert.ok(
    status.lanes.some(
      (item) => item.status === "INVALID_LANE_NAME_REVIEW_REQUIRED",
    ),
  );
  assert.equal(fs.existsSync(unsafe), true);
  assert.equal(JSON.stringify(status).includes("invalid+name"), false);
});

test("worktree status still enforces read grant before inspecting private state", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.dispatch("worktree_lane_status", f.scope, ["execute"]),
    /ACCESS_DENIED/,
  );
  assert.equal(fs.existsSync(path.join(f.state, "isolated-worktrees")), false);
});
