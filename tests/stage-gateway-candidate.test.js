import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/stage-gateway-candidate.sh", import.meta.url),
);
const source = fs.readFileSync(script, "utf8");

test("operator staging is SHA-pinned, local, fail-closed and never restarts live gateway", () => {
  for (const guard of [
    "STAGING=BLOCKED_INVALID_SHA",
    "STAGING=BLOCKED_WRONG_HOST_OR_USER",
    "STAGING=BLOCKED_CANDIDATE_EXISTS",
    "GIT_TERMINAL_PROMPT=0",
    "STAGING_GATE=$gate",
    "status --porcelain",
    "npm --prefix",
    "ci --ignore-scripts",
    "APPLY=NOT_REQUESTED",
  ]) {
    assert.ok(source.includes(guard), guard);
  }
  assert.match(source, /for gate in check test scan:secrets/);
  assert.match(source, /--depth 1 --no-tags/);
  assert.doesNotMatch(source, /systemctl\s+(?:restart|stop)|--apply/);
  assert.doesNotMatch(source, /git\s+reset\s+--hard|git\s+clean\s+-f/);
});

test("gate-staging handles only untracked test debris with fresh exact-commit checkout", () => {
  for (const guard of [
    "STAGING=BLOCKED_HEAD_DRIFT",
    "STAGING=BLOCKED_TRACKED_CHANGES",
    "status --porcelain --untracked-files=no",
    "STAGING=BLOCKED_DEPENDENCY_MISSING",
    "ls-files --others --exclude-standard",
    "STAGING=UNTRACKED_TEST_OUTPUT_REBUILDING_CLEAN_CANDIDATE",
    "clone -q --no-local --no-checkout",
    "checkout --detach -q",
    "remote set-url origin",
    "STAGING=BLOCKED_CANDIDATE_DIRTY",
    "STAGING_CLEAN_CANDIDATE=PASS",
  ]) {
    assert.ok(source.includes(guard), guard);
  }
  assert.ok(
    source.indexOf("STAGING=BLOCKED_TRACKED_CHANGES") <
      source.indexOf("STAGING=UNTRACKED_TEST_OUTPUT_REBUILDING_CLEAN_CANDIDATE"),
  );
  assert.ok(
    source.indexOf("STAGING_CLEAN_CANDIDATE=PASS") <
      source.indexOf('mv -T -- "$stage" "$target"'),
  );
  assert.doesNotMatch(source, /git\s+(?:reset|clean)\b/);
});

test(
  "local exact-commit clone excludes untracked test output, no reset or clean",
  { skip: process.platform === "win32" },
  (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-clean-stage-"));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const src = path.join(base, "tested");
    const dst = path.join(base, "clean");
    fs.mkdirSync(src);
    const git = (...args) => {
      const result = spawnSync("git", args, { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q", src);
    fs.writeFileSync(path.join(src, "committed.txt"), "approved\\n");
    git("-C", src, "add", "committed.txt");
    git("-C", src, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid",
      "commit", "-qm", "baseline");
    const sha = git("-C", src, "rev-parse", "HEAD");
    git("-C", src, "checkout", "--detach", "-q", sha);
    fs.writeFileSync(path.join(src, "test-generated.log.txt"), "throwaway\\n");
    git("clone", "-q", "--no-local", "--no-checkout", src, dst);
    git("-C", dst, "checkout", "--detach", "-q", sha);
    assert.equal(git("-C", dst, "rev-parse", "HEAD"), sha);
    assert.equal(git("-C", dst, "status", "--porcelain"), "");
    assert.equal(fs.existsSync(path.join(dst, "test-generated.log.txt")), false);
    assert.equal(fs.readFileSync(path.join(dst, "committed.txt"), "utf8"), "approved\\n");
  },
);

test(
  "bash syntax and invalid SHA are rejected before privileged operations",
  { skip: process.platform === "win32" },
  () => {
    const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    for (const args of [[], ["main"], ["a".repeat(39)], ["A".repeat(40)]]) {
      const result = spawnSync("bash", [script, ...args], {
        encoding: "utf8",
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /STAGING=BLOCKED_INVALID_SHA/);
    }
  },
);
