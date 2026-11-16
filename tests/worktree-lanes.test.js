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
  assert.equal(
    lanes.prepareCurrentHead("project1", x.repo, "mainplatform_ci").reused,
    true,
  );

  fs.writeFileSync(path.join(x.repo, "README.md"), "new tracked commit\n");
  git(x.repo, "add", "README.md");
  git(x.repo, "commit", "-qm", "new head");
  const head2 = git(x.repo, "rev-parse", "HEAD");
  const next = lanes.prepareCurrentHead("project1", x.repo, "mainplatform_ci");
  assert.equal(next.head, head2);
  assert.notEqual(next.path, first.path);
  assert.equal(git(first.path, "rev-parse", "HEAD"), x.head);
  assert.equal(git(next.path, "rev-parse", "HEAD"), head2);
  assert.equal(
    fs.readFileSync(path.join(first.path, "README.md"), "utf8"),
    "original\n",
  );
  assert.equal(
    fs.readFileSync(path.join(next.path, "README.md"), "utf8"),
    "new tracked commit\n",
  );
  assert.equal(
    lanes.cleanup("project1", x.repo, next.laneId, head2).released,
    true,
  );
  assert.equal(
    lanes.cleanup("project1", x.repo, first.laneId, x.head).released,
    true,
  );
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

test("cached origin/main can be verified in a detached lane while local main is dirty and behind", (t) => {
  const x = fixture(t);
  fs.writeFileSync(path.join(x.repo, "README.md"), "remote source\\n");
  git(x.repo, "add", "README.md");
  git(x.repo, "commit", "-qm", "new remote main");
  const remote = git(x.repo, "rev-parse", "HEAD");
  git(x.repo, "update-ref", "refs/remotes/origin/main", remote);
  git(x.repo, "reset", "--hard", x.head);
  fs.writeFileSync(path.join(x.repo, "README.md"), "LOCAL USER EDIT\\n");
  fs.writeFileSync(path.join(x.repo, "do-not-delete.txt"), "PRESERVE\\n");

  const lanes = new WorktreeLanes(x.state);
  assert.throws(
    () => lanes.prepareCachedRemoteMain("project1", x.repo, "stale", x.head),
    /WORKTREE_REMOTE_HEAD_MISMATCH/,
  );
  const lane = lanes.prepareCachedRemoteMain(
    "project1",
    x.repo,
    "current",
    remote,
  );
  assert.equal(lane.head, remote);
  assert.equal(lane.dirty, false);
  assert.equal(lane.reused, false);
  assert.equal(git(lane.path, "rev-parse", "HEAD"), remote);
  assert.equal(
    fs.readFileSync(path.join(lane.path, "README.md"), "utf8"),
    "remote source\\n",
  );
  assert.equal(
    fs.readFileSync(path.join(x.repo, "README.md"), "utf8"),
    "LOCAL USER EDIT\\n",
  );
  assert.equal(
    fs.readFileSync(path.join(x.repo, "do-not-delete.txt"), "utf8"),
    "PRESERVE\\n",
  );
  assert.equal(
    lanes.prepareCachedRemoteMain("project1", x.repo, "current", remote).reused,
    true,
  );
  assert.equal(
    lanes.cleanup("project1", x.repo, "current", remote).released,
    true,
  );
});

test("cached origin/main is strict, opt-in, and refuses missing tracking ref", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  assert.throws(
    () => lanes.prepareCachedRemoteMain("project1", x.repo, "fresh", x.head),
    /WORKTREE_GIT_FAILED/,
  );
  assert.throws(
    () =>
      lanes.prepareCachedRemoteMain("project1", x.repo, "../escape", x.head),
    /WORKTREE_INPUT_INVALID/,
  );
  assert.equal(definitions.worktree_lane_prepare_cached_main.access, "execute");
  assert.equal(
    definitions.worktree_lane_prepare_cached_main.input.approveLocalGitCheckout.safeParse(
      undefined,
    ).success,
    false,
  );
});

test("owner-set short lane base hosts lanes outside stateDir and rejects unsafe values", (t) => {
  const x = fixture(t);
  const short = path.join(path.dirname(x.state), "short");
  fs.mkdirSync(short);
  const lanes = new WorktreeLanes(x.state, short);
  const lane = lanes.prepare("project1", x.repo, "chatA", x.head);
  assert.equal(lane.head, x.head);
  assert.ok(lane.path.startsWith(fs.realpathSync(short) + path.sep));
  assert.ok(!lane.path.startsWith(fs.realpathSync(x.state) + path.sep));
  assert.equal(lanes.prepare("project1", x.repo, "chatA", x.head).reused, true);
  assert.equal(
    lanes.cleanup("project1", x.repo, "chatA", x.head).released,
    true,
  );
  for (const bad of [
    "relative/path",
    `${short}${path.sep}..${path.sep}short`,
    path.join(short, "missing"),
    `${short}\u0001`,
    42,
  ]) {
    assert.throws(() => new WorktreeLanes(x.state, bad), /WORKTREE_/);
  }
  // No base keeps the legacy location under stateDir.
  const legacy = new WorktreeLanes(x.state).prepare(
    "project1",
    x.repo,
    "chatB",
    x.head,
  );
  assert.ok(legacy.path.startsWith(fs.realpathSync(x.state) + path.sep));
});

test("generated cmake build directory does not make a lane dirty and is removed on cleanup", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  const lane = lanes.prepare("project1", x.repo, "cmakeLane", x.head);
  const build = path.join(lane.path, ".kmj-codebridge-build");
  fs.mkdirSync(path.join(build, "CMakeFiles"), { recursive: true });
  fs.writeFileSync(path.join(build, "CMakeCache.txt"), "generated\n");
  assert.equal(lanes.status("project1", x.repo).lanes[0].dirty, false);
  // The same lane can be reused for the next command in the profile.
  assert.equal(
    lanes.prepare("project1", x.repo, "cmakeLane", x.head).reused,
    true,
  );
  // Any other untracked file still counts as unsaved work.
  fs.writeFileSync(path.join(lane.path, "notes.txt"), "mine\n");
  assert.equal(lanes.status("project1", x.repo).lanes[0].dirty, true);
  assert.throws(
    () => lanes.cleanup("project1", x.repo, "cmakeLane", x.head),
    /WORKTREE_HAS_UNSAVED_WORK/,
  );
  // A modified tracked file inside is dirty too; remove the extra file and cleanup works.
  fs.rmSync(path.join(lane.path, "notes.txt"));
  assert.equal(lanes.status("project1", x.repo).lanes[0].dirty, false);
  assert.equal(
    lanes.cleanup("project1", x.repo, "cmakeLane", x.head).released,
    true,
  );
  assert.equal(fs.existsSync(lane.path), false);
});

test("read-only worktree doctor reports empty state without creating a lane folder", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  const privateRoot = path.join(x.state, "isolated-worktrees");
  assert.equal(fs.existsSync(privateRoot), false);
  const result = lanes.diagnose("project1", x.repo);
  assert.equal(result.status, "NO_PRIVATE_LANES");
  assert.deepEqual(result.lanes, []);
  assert.equal(result.cleanupPerformed, false);
  assert.equal(result.mayPrepare, false);
  assert.equal(fs.existsSync(privateRoot), false);
  assert.equal(definitions.worktree_lane_diagnose.access, "read");
});

test("read-only worktree doctor isolates a broken git link without hiding other dirty lanes", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  const good = lanes.prepare("project1", x.repo, "dirtyOwner", x.head);
  const broken = lanes.prepare("project1", x.repo, "receipt", x.head);
  const ownerFile = path.join(good.path, "owner-untracked.txt");
  fs.writeFileSync(ownerFile, "KEEP OWNER WORK\n");
  const marker = path.join(broken.path, ".git");
  const disabled = path.join(broken.path, ".git.disabled");
  // Corruption is deliberately confined to a disposable test worktree.
  fs.renameSync(marker, disabled);
  assert.throws(() => lanes.status("project1", x.repo), /WORKTREE_GIT_FAILED/);
  const result = lanes.diagnose("project1", x.repo);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.deepEqual(
    result.lanes.map(({ laneId, status }) => [laneId, status]),
    [
      ["dirtyOwner", "INSPECTED"],
      ["receipt", "LANE_GIT_LINK_INVALID_REVIEW_REQUIRED"],
    ],
  );
  assert.equal(result.lanes[0].dirty, true);
  assert.equal(result.lanes[0].head, x.head);
  assert.equal(fs.readFileSync(ownerFile, "utf8"), "KEEP OWNER WORK\n");
  assert.equal(fs.existsSync(disabled), true);
  assert.equal(result.cleanupPerformed, false);
  assert.equal(result.mayPrepare, false);
  assert.equal(JSON.stringify(result).includes(x.repo), false);
  assert.equal(JSON.stringify(result).includes(x.state), false);
});

test("read-only worktree doctor hides invalid private lane names and refuses cleanup", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  lanes.prepare("project1", x.repo, "safe", x.head);
  const invalid = path.join(
    x.state,
    "isolated-worktrees",
    "project1",
    "bad+name",
  );
  fs.mkdirSync(invalid);
  const result = lanes.diagnose("project1", x.repo);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.lanes.length, 2);
  assert.equal(result.lanes[0].laneId, null);
  assert.equal(result.lanes[0].status, "INVALID_LANE_NAME_REVIEW_REQUIRED");
  assert.equal(result.lanes[1].laneId, "safe");
  assert.equal(result.lanes[1].status, "INSPECTED");
  assert.equal(JSON.stringify(result).includes("bad+name"), false);
  assert.equal(result.mayPrepare, false);
  assert.throws(() => lanes.status("project1", x.repo), /WORKTREE_PATH_UNSAFE/);
  assert.equal(fs.existsSync(invalid), true);
});

test("read-only worktree doctor does not mask over-limit private lane state", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  lanes.prepare("project1", x.repo, "one", x.head);
  const home = path.join(x.state, "isolated-worktrees", "project1");
  for (const name of ["two", "three", "four", "five"])
    fs.mkdirSync(path.join(home, name));
  const result = lanes.diagnose("project1", x.repo);
  assert.equal(result.status, "LANE_LIMIT_EXCEEDED_REVIEW_REQUIRED");
  assert.deepEqual(result.lanes, []);
  assert.equal(result.mayPrepare, false);
  assert.throws(
    () => lanes.status("project1", x.repo),
    /WORKTREE_LIMIT_EXCEEDED/,
  );
});

test("read-only worktree doctor detects registered lane whose private directory vanished", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  const missing = lanes.prepare("project1", x.repo, "vanished", x.head);
  const relocated = path.join(x.state, "relocated-owned-worktree");
  // Only disposable fixture data is moved. The Git registry deliberately
  // continues referencing the old path after an interrupted removal.
  fs.renameSync(missing.path, relocated);
  const observed = lanes.diagnose("project1", x.repo);
  assert.equal(observed.status, "REVIEW_REQUIRED");
  assert.deepEqual(observed.lanes, [
    {
      laneId: "vanished",
      status: "REGISTERED_LANE_PATH_MISSING_REVIEW_REQUIRED",
    },
  ]);
  assert.equal(observed.cleanupPerformed, false);
  assert.equal(observed.mayPrepare, false);
  assert.equal(fs.existsSync(relocated), true);
  assert.equal(
    fs.readFileSync(path.join(relocated, "README.md"), "utf8"),
    "original\n",
  );
});

test("deep untracked owner work stays dirty without overflowing lane scans", (t) => {
  const x = fixture(t);
  const lanes = new WorktreeLanes(x.state);
  const lane = lanes.prepare("project1", x.repo, "ownerDirty", x.head);
  const dir = path.join(lane.path, "owner-untracked", "deep");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 320; i += 1) {
    fs.writeFileSync(
      path.join(dir, `${String(i).padStart(4, "0")}.txt`),
      "PRESERVE OWNER WORK\\n",
    );
  }

  // --all enumerates every deep file; --normal retains the dirty signal
  // with a single untracked directory entry. Neither command changes files.
  const detailed = git(lane.path, "status", "--porcelain", "--untracked-files=all");
  const condensed = git(lane.path, "status", "--porcelain", "--untracked-files=normal");
  assert.ok(detailed.length > 8192);
  assert.ok(condensed.length < 256);
  assert.equal(lanes.status("project1", x.repo).lanes[0].dirty, true);
  const diagnosed = lanes.diagnose("project1", x.repo);
  assert.equal(diagnosed.status, "READ_ONLY_INVENTORY");
  assert.equal(diagnosed.lanes[0].dirty, true);
  assert.throws(
    () => lanes.cleanup("project1", x.repo, "ownerDirty", x.head),
    /WORKTREE_HAS_UNSAVED_WORK/,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "0000.txt"), "utf8"),
    "PRESERVE OWNER WORK\\n",
  );
});
