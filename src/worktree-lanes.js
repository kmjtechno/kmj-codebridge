import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fail } from "./errors.js";

const LANE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_LANES = 4;

function git(root, args) {
  try {
    return execFileSync(
      "git",
      ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 65536,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    ).trim();
  } catch {
    fail("WORKTREE_GIT_FAILED");
  }
}
function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    fail("WORKTREE_PATH_UNSAFE");
  }
}
function directory(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("WORKTREE_PATH_UNSAFE");
  return fs.realpathSync(target);
}
function canonical(target) {
  const real = fs.realpathSync(target);
  return process.platform === "win32" ? real.toLowerCase() : real;
}
function source(root) {
  const safe = directory(root);
  if (
    git(safe, ["rev-parse", "--is-bare-repository"]) !== "false" ||
    canonical(git(safe, ["rev-parse", "--show-toplevel"])) !== canonical(safe)
  )
    fail("WORKTREE_SOURCE_INVALID");
  return safe;
}
function common(root) {
  return canonical(path.resolve(root, git(root, ["rev-parse", "--git-common-dir"])));
}
function verifyLane(root, candidate) {
  if (
    common(root) !== common(candidate) ||
    canonical(git(candidate, ["rev-parse", "--show-toplevel"])) !== canonical(candidate)
  )
    fail("WORKTREE_SOURCE_MISMATCH");
}
export class WorktreeLanes {
  constructor(stateDir) {
    this.stateDir = directory(stateDir);
    this.base = path.join(this.stateDir, "isolated-worktrees");
  }
  folder(project) {
    if (!PROJECT.test(project)) fail("WORKTREE_PROJECT_INVALID");
    if (!exists(this.base)) fs.mkdirSync(this.base, { mode: 0o700 });
    directory(this.base);
    const home = path.join(this.base, project);
    if (!exists(home)) fs.mkdirSync(home, { mode: 0o700 });
    return directory(home);
  }
  entries(project, root) {
    const parent = this.folder(project);
    const names = fs.readdirSync(parent);
    if (names.length > MAX_LANES) fail("WORKTREE_LIMIT_EXCEEDED");
    return names
      .map((name) => {
        if (!LANE.test(name)) fail("WORKTREE_PATH_UNSAFE");
        const target = directory(path.join(parent, name));
        verifyLane(root, target);
        const head = git(target, ["rev-parse", "--verify", "HEAD"]);
        const dirty =
          git(target, ["status", "--porcelain", "--untracked-files=all"]) !==
          "";
        return { laneId: name, head, dirty };
      })
      .sort((a, b) => a.laneId.localeCompare(b.laneId));
  }
  status(project, root) {
    return {
      lanes: this.entries(project, source(root)),
      limit: MAX_LANES,
      noAdditionalExecutionSlots: true,
    };
  }
  prepare(project, root, laneId, expectedHead) {
    if (!LANE.test(laneId) || !SHA.test(expectedHead))
      fail("WORKTREE_INPUT_INVALID");
    const repo = source(root);
    if (git(repo, ["rev-parse", "HEAD"]) !== expectedHead)
      fail("WORKTREE_HEAD_MISMATCH");
    const rows = this.entries(project, repo);
    const target = path.join(this.folder(project), laneId);
    const reused = rows.find((row) => row.laneId === laneId);
    if (reused) {
      if (reused.head !== expectedHead) fail("WORKTREE_HEAD_MISMATCH");
      return { ...reused, path: target, reused: true };
    }
    if (rows.length >= MAX_LANES || exists(target))
      fail("WORKTREE_LIMIT_EXCEEDED");
    // Fixed argv, no shell, no force and never touches source working files.
    git(repo, ["worktree", "add", "--detach", target, expectedHead]);
    const verified = this.entries(project, repo).find(
      (row) => row.laneId === laneId,
    );
    if (!verified || verified.head !== expectedHead)
      fail("WORKTREE_CREATE_UNVERIFIED");
    return { ...verified, path: target, reused: false };
  }
  cleanup(project, root, laneId, expectedHead) {
    if (!LANE.test(laneId) || !SHA.test(expectedHead))
      fail("WORKTREE_INPUT_INVALID");
    const repo = source(root);
    const current = this.entries(project, repo).find(
      (row) => row.laneId === laneId,
    );
    if (!current) fail("WORKTREE_NOT_FOUND");
    if (current.head !== expectedHead || current.dirty)
      fail("WORKTREE_HAS_UNSAVED_WORK");
    const target = path.join(this.folder(project), laneId);
    git(repo, ["worktree", "remove", target]);
    if (exists(target)) fail("WORKTREE_REMOVE_UNVERIFIED");
    return { released: true, laneId, originalCheckoutPreserved: true };
  }
}
