import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeLanes } from "../src/worktree-lanes.js";
import { definitions } from "../src/tools.js";

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-worktree-"));
  t.after(() =>
    fs.rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const repo = path.join(base, "repo");
  const state = path.join(base, "state");
  fs.mkdirSync(repo);
  fs.mkdirSync(state);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "KMJ Test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "original\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "initial");
  return { repo, state, head: git(repo, "rev-parse", "HEAD") };
}
test("parallel worktrees are isolated, detached, pinned and reusable", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  const one = lanes.prepare("project1", x.repo, "chatA", x.head);
  const two = lanes.prepare("project1", x.repo, "chatB", x.head);
  assert.equal(one.head, x.head);
  assert.equal(one.reused, false);
  assert.notEqual(one.path, two.path);
  assert.equal(lanes.prepare("project1", x.repo, "chatA", x.head).reused, true);
  assert.equal(
    fs.readFileSync(path.join(one.path, "README.md"), "utf8"),
    "original\n",
  );
  assert.equal(
    fs.readFileSync(path.join(x.repo, "README.md"), "utf8"),
    "original\n",
  );
  assert.deepEqual(
    lanes.status("project1", x.repo).lanes.map((l) => l.laneId),
    ["chatA", "chatB"],
  );
  assert.deepEqual(
    lanes
      .status("project1", x.repo)
      .lanes.map((l) => l.path)
      .sort(),
    [one.path, two.path].sort(),
  );
  assert.equal(
    lanes.cleanup("project1", x.repo, "chatB", x.head).released,
    true,
  );
  assert.equal(
    lanes.cleanup("project1", x.repo, "chatA", x.head).released,
    true,
  );
  assert.equal(lanes.status("project1", x.repo).lanes.length, 0);
});
test("auto CI lane follows immutable source HEAD without reusing a stale lane", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  const first = lanes.prepareCurrentHead("project1", x.repo, "mainplatform_ci");
  assert.equal(first.head, x.head);
  assert.equal(first.laneId, `mainplatform_ci_${x.head.slice(0, 12)}`);
  assert.equal(lanes.prepareCurrentHead("project1", x.repo, "mainplatform_ci").reused, true);

  fs.writeFileSync(path.join(x.repo, "README.md"), "new tracked commit\n");
  git(x.repo, "add", "README.md");
  git(x.repo, "commit", "-qm", "new head");
  const head2 = git(x.repo, "rev-parse", "HEAD");
  const next = lanes.prepareCurrentHead("project1", x.repo, "mainplatform_ci");
  assert.equal(next.head, head2);
  assert.notEqual(next.path, first.path);
  assert.equal(git(first.path, "rev-parse", "HEAD"), x.head);
  assert.equal(git(next.path, "rev-parse", "HEAD"), head2);
  assert.equal(fs.readFileSync(path.join(first.path, "README.md"), "utf8"), "original\n");
  assert.equal(fs.readFileSync(path.join(next.path, "README.md"), "utf8"), "new tracked commit\n");
  assert.equal(lanes.cleanup("project1", x.repo, next.laneId, head2).released, true);
  assert.equal(lanes.cleanup("project1", x.repo, first.laneId, x.head).released, true);
});

test("dirty or committed worktree changes are never force-deleted", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  const worktree = lanes.prepare("project1", x.repo, "task01", x.head);
  fs.writeFileSync(path.join(worktree.path, "do-not-delete.txt"), "KEEP");
  assert.throws(
    () => lanes.cleanup("project1", x.repo, "task01", x.head),
    /WORKTREE_HAS_UNSAVED_WORK/,
  );
  assert.ok(fs.existsSync(path.join(worktree.path, "do-not-delete.txt")));
  assert.throws(
    () => lanes.prepare("project1", x.repo, "../outside", x.head),
    /WORKTREE_INPUT_INVALID/,
  );
  assert.throws(
    () => lanes.prepare("project1", x.repo, "newTask", "0".repeat(40)),
    /WORKTREE_HEAD_MISMATCH/,
  );
});
test("rejects starting from a nested subdirectory instead of repo root", (t) => {
  const x = fixture(t);
  const nested = path.join(x.repo, "nested");
  fs.mkdirSync(nested);
  const lanes = new WorktreeLanes(x.state);
  assert.throws(
    () => lanes.prepare("project1", nested, "nope", x.head),
    /WORKTREE_SOURCE_INVALID/,
  );
});
test("tool grants remain separate from customer project permissions", () => {
  assert.equal(definitions.worktree_lane_status.access, "read");
  assert.equal(definitions.worktree_lane_prepare.access, "execute");
  assert.equal(definitions.worktree_lane_cleanup.access, "execute");
  assert.equal(
    definitions.worktree_lane_prepare.input.approveLocalGitCheckout.safeParse(
      undefined,
    ).success,
    false,
  );
});
