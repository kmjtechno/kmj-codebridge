import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stageRuntime } from "../scripts/stage-main-platform-runtime.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-stage-test-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "staged");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(source, "src"));
  fs.mkdirSync(path.join(source, "node_modules", "dummy"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "src", "cli.js"),
    "export const live = true;\n",
  );
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ name: "@kmjtechno/codebridge", version: "0.3.2" }),
  );
  fs.writeFileSync(path.join(source, "package-lock.json"), "{}\n");
  fs.writeFileSync(
    path.join(source, "node_modules", "dummy", "index.js"),
    "export default true;\n",
  );
  git(source, "init", "--initial-branch=main", "-q");
  git(source, "add", ".");
  git(
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  const sha = git(source, "rev-parse", "HEAD");
  git(source, "update-ref", "refs/remotes/origin/main", sha);
  return { root, source, destination, sha };
}

function dispose(root) {
  // Make only this test-created temporary directory writable for teardown.
  function unlock(directory) {
    for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
      if (e.isDirectory()) unlock(path.join(directory, e.name));
    }
    fs.chmodSync(directory, 0o700);
  }
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
}

test("bounded readonly stage reuses exact immutable Git revision", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX owner/mode checks are verified on Linux CI");
    return;
  }
  const { root, source, destination, sha } = fixture();
  try {
    const stage = stageRuntime({ source, destination, requireRoot: false });
    assert.equal(stage.created, true);
    assert.equal(stage.sha, sha);
    assert.equal(path.basename(stage.directory), sha);
    assert.equal(fs.lstatSync(stage.directory).mode & 0o222, 0);
    assert.equal(
      fs.lstatSync(path.join(stage.directory, "src/cli.js")).mode & 0o222,
      0,
    );
    assert.equal(
      fs.readFileSync(path.join(stage.directory, "src/cli.js"), "utf8"),
      "export const live = true;\n",
    );
    assert.equal(fs.existsSync(path.join(stage.directory, ".git")), false);
    const repeated = stageRuntime({ source, destination, requireRoot: false });
    assert.equal(repeated.created, false);
    assert.equal(repeated.directory, stage.directory);
  } finally {
    dispose(root);
  }
});

test("refuses uncommitted changes rather than staging dirty source", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX owner/mode checks are verified on Linux CI");
    return;
  }
  const { root, source, destination } = fixture();
  try {
    fs.appendFileSync(path.join(source, "src/cli.js"), "// modified\n");
    assert.throws(
      () => stageRuntime({ source, destination, requireRoot: false }),
      /MAIN_PLATFORM_STAGE_REVISION_UNVERIFIED/,
    );
  } finally {
    dispose(root);
  }
});

test("refuses source revision that differs from origin/main", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX owner/mode checks are verified on Linux CI");
    return;
  }
  const { root, source, destination } = fixture();
  try {
    git(
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "move local HEAD ahead of origin/main",
    );
    assert.throws(
      () => stageRuntime({ source, destination, requireRoot: false }),
      /MAIN_PLATFORM_STAGE_REVISION_UNVERIFIED/,
    );
  } finally {
    dispose(root);
  }
});

test("refuses writable or corrupted reused stage", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX owner/mode checks are verified on Linux CI");
    return;
  }
  const { root, source, destination } = fixture();
  try {
    const stage = stageRuntime({ source, destination, requireRoot: false });
    fs.chmodSync(stage.directory, 0o755);
    assert.throws(
      () => stageRuntime({ source, destination, requireRoot: false }),
      /MAIN_PLATFORM_STAGE_EXISTING_UNSAFE/,
    );
  } finally {
    dispose(root);
  }
});

test("rejects invalid Node agent syntax before publishing any stage", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX staging checks are verified on Linux CI");
    return;
  }
  const { root, source, destination } = fixture();
  try {
    fs.writeFileSync(path.join(source, "src/cli.js"), "export default ===;\n");
    git(source, "add", "src/cli.js");
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.test",
      "commit", "-qm", "invalid syntax");
    git(source, "update-ref", "refs/remotes/origin/main",
      git(source, "rev-parse", "HEAD"));
    assert.throws(
      () => stageRuntime({ source, destination, requireRoot: false }),
      /Command failed/,
    );
    assert.equal(fs.readdirSync(destination).some(p => /^[a-f0-9]{40}$/.test(p)), false);
  } finally {
    dispose(root);
  }
});

test("CLI has fixed paths and accepts no caller-specified destination", () => {
  const script = fs.readFileSync(
    "scripts/stage-main-platform-runtime.js",
    "utf8",
  );
  assert.match(script, /MAIN_PLATFORM_STAGE_ACCEPTS_NO_ARGUMENTS/);
  assert.match(script, /const SOURCE = "\/opt\/kmj-codebridge-agent"/);
  assert.match(
    script,
    /const DESTINATION = "\/opt\/kmj-codebridge-main-platform-stage"/,
  );
  assert.match(script, /MAIN_PLATFORM_STAGE_REQUIRES_ROOT/);
  assert.doesNotMatch(script, /process\.env\.CODEBRIDGE_STAGE_SOURCE/);
});
