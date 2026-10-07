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
