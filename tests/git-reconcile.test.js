import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/tools.js";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-git-reconcile-"));
  const remote = path.join(base, "remote.git");
  const root = path.join(base, "project");
  const publisher = path.join(base, "publisher");
  fs.mkdirSync(root);
  git(base, ["init", "--bare", remote]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["init"]);
  git(root, ["checkout", "-b", "main"]);
  git(root, ["config", "user.name", "CodeBridge Test"]);
  git(root, ["config", "user.email", "codebridge@example.invalid"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "initial\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  const initial = git(root, ["rev-parse", "HEAD"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-u", "origin", "main"]);

  git(base, ["clone", remote, publisher]);
  git(publisher, ["config", "user.name", "CodeBridge Publisher"]);
  git(publisher, ["config", "user.email", "publisher@example.invalid"]);
  fs.writeFileSync(path.join(publisher, "tracked.txt"), "merged\n");
  git(publisher, ["add", "tracked.txt"]);
  git(publisher, ["commit", "-m", "merged"]);
  const merged = git(publisher, ["rev-parse", "HEAD"]);
  git(publisher, ["push", "origin", "main"]);

  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: true, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  const scope = { device: "d1", project: "p1" };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { root, initial, merged, dispatch, scope };
}

test("git_reconcile_main advances only when local bytes already equal exact origin/main", async (t) => {
  const { root, merged, dispatch, scope } = fixture(t);
  fs.writeFileSync(path.join(root, "tracked.txt"), "merged\n");

  const result = await dispatch(
    "git_reconcile_main",
    { ...scope, expectedRemoteHead: merged },
    ["execute"],
  );

  assert.deepEqual(result, { reconciled: true, head: merged });
  assert.equal(git(root, ["rev-parse", "HEAD"]), merged);
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

test("git_reconcile_main refuses mismatched tracked content", async (t) => {
  const { root, initial, merged, dispatch, scope } = fixture(t);
  fs.writeFileSync(path.join(root, "tracked.txt"), "different\n");

  await assert.rejects(
    dispatch("git_reconcile_main", { ...scope, expectedRemoteHead: merged }, [
      "execute",
    ]),
    /GIT_RECONCILE_CONTENT_MISMATCH/,
  );
  assert.equal(git(root, ["rev-parse", "HEAD"]), initial);
});

test("git_reconcile_main refuses any untracked file", async (t) => {
  const { root, initial, merged, dispatch, scope } = fixture(t);
  fs.writeFileSync(path.join(root, "tracked.txt"), "merged\n");
  fs.writeFileSync(path.join(root, "keep-me.txt"), "do not delete\n");

  await assert.rejects(
    dispatch("git_reconcile_main", { ...scope, expectedRemoteHead: merged }, [
      "execute",
    ]),
    /GIT_RECONCILE_UNTRACKED/,
  );
  assert.equal(git(root, ["rev-parse", "HEAD"]), initial);
  assert.equal(
    fs.readFileSync(path.join(root, "keep-me.txt"), "utf8"),
    "do not delete\n",
  );
});

test("git_index_probe reports CRLF-vs-index without mutating the checkout", async (t) => {
  const { root, dispatch, scope } = fixture(t);
  git(root, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "initial\r\n");
  const before = git(root, ["status", "--porcelain"]);
  const result = await dispatch(
    "git_index_probe",
    { ...scope, path: "tracked.txt" },
    ["read"],
  );
  assert.equal(result.path, "tracked.txt");
  assert.match(result.indexBlob, /^[a-f0-9]{40}$/);
  assert.equal(result.rawEqualsIndex, false);
  assert.equal(result.lfNormalizedEqualsIndex, true);
  assert.equal(result.hasCrLf, true);
  assert.equal(result.indexChanged, false);
  assert.equal(git(root, ["status", "--porcelain"]), before);
  assert.equal(
    fs.readFileSync(path.join(root, "tracked.txt"), "utf8"),
    "initial\r\n",
  );
});

test("git_index_probe refuses untracked file and escapes", async (t) => {
  const { root, dispatch, scope } = fixture(t);
  fs.writeFileSync(path.join(root, "untracked.txt"), "nothing confidential\n");
  await assert.rejects(
    dispatch("git_index_probe", { ...scope, path: "untracked.txt" }, ["read"]),
    /GIT_INDEX_PROBE_NOT_SINGLE_TRACKED_FILE/,
  );
  await assert.rejects(
    dispatch("git_index_probe", { ...scope, path: "../project/tracked.txt" }, [
      "read",
    ]),
    /OUTSIDE|DENIED|INVALID|PATH|TRAVERSAL|FORBIDDEN/,
  );
});

test("git_index_probe returns matching raw blob for unchanged tracked file", async (t) => {
  const { dispatch, scope } = fixture(t);
  const result = await dispatch(
    "git_index_probe",
    { ...scope, path: "tracked.txt" },
    ["read"],
  );
  assert.equal(result.rawEqualsIndex, true);
  assert.equal(result.lfNormalizedEqualsIndex, true);
  assert.equal(result.indexBlob, result.rawBlob);
});
