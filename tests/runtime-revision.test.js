import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runtimeRevision } from "../src/runtime-revision.js";

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rev-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  git("add", "a.txt");
  git(
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "one",
  );
  return { root, git, head: git("rev-parse", "HEAD") };
}

test("branch checkout reports its loose or packed ref commit", (t) => {
  const { root, git, head } = repo(t);
  assert.deepEqual(runtimeRevision(root), {
    commit: head,
    source: "git-branch",
  });
  git("pack-refs", "--all", "--prune");
  assert.equal(fs.existsSync(path.join(root, ".git/refs/heads/main")), false);
  assert.deepEqual(runtimeRevision(root), {
    commit: head,
    source: "git-branch",
  });
});

test("detached release worktree reports the commit it runs, not the checkout's", (t) => {
  const { root, git, head } = repo(t);
  fs.writeFileSync(path.join(root, "a.txt"), "b");
  git(
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qam",
    "two",
  );
  const release = path.join(root, "..", path.basename(root) + "-release");
  t.after(() => fs.rmSync(release, { recursive: true, force: true }));
  git("worktree", "add", "--detach", release, head);
  const newer = git("rev-parse", "HEAD");
  assert.notEqual(newer, head);
  assert.deepEqual(runtimeRevision(release), {
    commit: head,
    source: "git-detached",
  });
  assert.equal(runtimeRevision(root).commit, newer);
});

test("a validated signed release marker wins over Git metadata", (t) => {
  const { root } = repo(t);
  const revision = "c".repeat(40);
  fs.writeFileSync(
    path.join(root, ".codebridge-release.json"),
    JSON.stringify({ schema: 1, revision }),
  );
  assert.deepEqual(runtimeRevision(root), {
    commit: revision,
    source: "release-marker",
  });
  fs.writeFileSync(
    path.join(root, ".codebridge-release.json"),
    JSON.stringify({ schema: 1, revision: "not-a-sha" }),
  );
  assert.equal(runtimeRevision(root).source, "git-branch");
});

test("missing, malformed or traversal metadata is unknown, never guessed", (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rev-none-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(runtimeRevision(empty), null);

  const { root } = repo(t);
  const headFile = path.join(root, ".git", "HEAD");
  fs.writeFileSync(headFile, "ref: refs/heads/../../config\n");
  assert.equal(runtimeRevision(root), null);
  fs.writeFileSync(headFile, "ref: refs/tags/v1\n");
  assert.equal(runtimeRevision(root), null);
  fs.writeFileSync(headFile, "<script>\n");
  assert.equal(runtimeRevision(root), null);
  fs.writeFileSync(headFile, "x".repeat(5000));
  assert.equal(runtimeRevision(root), null);
});

test("this repository's own runtime revision is a full SHA or unknown", () => {
  const value = runtimeRevision();
  if (value !== null) assert.match(value.commit, /^[a-f0-9]{40}$/);
});
