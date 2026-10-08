import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prepare = path.join(root, "scripts/ci-main-platform-pr.sh");
const worker = path.join(root, "scripts/ci-main-platform-pr-worker.sh");
const script = fs.readFileSync(prepare, "utf8");
const source = fs.readFileSync(worker, "utf8");

test("owner CI lock reads ignore inherited Git repository overrides", (t) => {
  if (process.platform === "win32") return t.skip("POSIX bash execution");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-git-env-"));
  try {
    const repo = path.join(temp, "source"),
      decoy = path.join(temp, "decoy");
    for (const dir of [repo, decoy]) {
      fs.mkdirSync(dir);
      execFileSync("git", ["-C", dir, "init", "-q"]);
    }
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    fs.mkdirSync(path.join(repo, "apps/platform"), { recursive: true });
    for (const name of ["composer.lock", "package-lock.json"])
      fs.writeFileSync(
        path.join(repo, "apps/platform", name),
        '{"locked":true}\n',
      );
    git("add", ".");
    git(
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const sha = git("rev-parse", "HEAD").trim();
    const content = fs.readFileSync(
      path.join(root, "scripts/ci-main-platform-pr.sh"),
      "utf8",
    );
    const helper = content.match(/git_read\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    const block = content.match(
      /for file in apps\/platform\/composer.lock[\s\S]*?\ndone/,
    )[0];
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -Eeuo pipefail; repo="$1"; sha="$2";\n' + helper + "\n" + block,
        "ci-lock",
        repo,
        sha,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: path.join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
        },
        timeout: 5000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("owner CI rejects symlinks even when a large tree follows the first link", (t) => {
  if (process.platform === "win32") return t.skip("POSIX bash execution");
  const content = fs.readFileSync(
    path.join(root, "scripts/ci-main-platform-pr.sh"),
    "utf8",
  );
  const block = content.match(/tree_listing=[\s\S]*?\nfi/)[0];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-symlink-tree-"));
  try {
    const fixture = path.join(temp, "tree");
    for (const symlink of [true, false]) {
      fs.writeFileSync(
        fixture,
        (symlink ? "120000 blob abc\tlink\n" : "") +
          "100644 blob abc\tfile\n".repeat(50000),
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          'set -Eeuo pipefail; sha=fixture; git_read() { cat "$FIXTURE_TREE"; };\n' +
            block,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, FIXTURE_TREE: fixture },
          timeout: 5000,
        },
      );
      assert.equal(result.status, symlink ? 3 : 0, result.stderr);
      if (symlink) assert.match(result.stderr, /CI_UNSAFE_TRACKED_SYMLINK/);
    }
    const failed = spawnSync(
      "bash",
      [
        "-c",
        "set -Eeuo pipefail; sha=fixture; git_read() { return 128; };\n" +
          block,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(failed.status, 3);
    assert.match(failed.stderr, /CI_TREE_READ_FAILED/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("owner CI readback distinguishes an unstarted unit from a completed run", async () => {
  const { createSupervisorHandler } = await import("../src/supervisor.js");
  for (const started of [false, true]) {
    const handle = createSupervisorHandler({
      run: (_bin, args) => {
        assert.ok(args.includes("--property=ExecMainStartTimestamp"));
        assert.ok(args.includes("--property=ExecMainExitTimestamp"));
        return `LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nExecMainStartTimestamp=${started ? "Thu 2026-10-08 12:00:00 UTC" : ""}\nExecMainExitTimestamp=${started ? "Thu 2026-10-08 12:01:00 UTC" : ""}\n`;
      },
      lstat: () => {
        throw new Error("no evidence");
      },
    });
    const result = (await handle({ op: "private_pr322_ci_status" })).response;
    assert.equal(result.last, null);
    assert.equal(
      result.service.execMainStartTimestamp,
      started ? "Thu 2026-10-08 12:00:00 UTC" : "",
    );
    assert.equal(
      result.service.execMainExitTimestamp,
      started ? "Thu 2026-10-08 12:01:00 UTC" : "",
    );
  }
});

test("owner trusted preparation leaves source read-only and worker unprivileged", () => {
  const unit = fs.readFileSync(
    path.join(root, "scripts/install-private-pr322-ci-unit.sh"),
    "utf8",
  );
  assert.match(unit, /^CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE$/m);
  assert.match(
    unit,
    /^ReadOnlyPaths=\/srv\/kmj-codebridge-projects\/kmj-main-platform \/opt\/kmj-codebridge-agent$/m,
  );
  assert.match(script, /-p CapabilityBoundingSet= \\/);
  assert.match(script, /-p User=kmjci -p Group=kmjci/);
  assert.doesNotMatch(unit, /systemctl (?:start|enable)/);
  const copyLines = script.split("\n").filter((line) => line.includes("cp -a"));
  assert.equal(copyLines.length, 3);
  for (const line of copyLines)
    assert.ok(line.includes("--no-preserve=ownership,timestamps"));
});

test("owner evidence remains bound to PR322", () => {
  assert.match(script, /"pr": 322/);
  assert.doesNotMatch(script, /"pr": 337|latest-pr337|website337/);
});
