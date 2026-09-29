import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { packageRuntime } from "../scripts/package-runtime.js";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-package-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@kmjtechno/codebridge", version: "0.1.0" }),
  );
  fs.writeFileSync(path.join(root, "src", "cli.js"), 'console.log("ready")');
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  return { root, git, out: path.join(dir, "out") };
}
test("runtime archive pins revision, includes source and excludes untracked secrets", (t) => {
  const { root, out } = fixture(t);
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE");
  const result = packageRuntime(root, out);
  const manifest = JSON.parse(fs.readFileSync(result.manifest));
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  assert.equal(
    manifest.sha256,
    createHash("sha256").update(fs.readFileSync(result.archive)).digest("hex"),
  );
  const entries = execFileSync("tar", ["-tzf", result.archive], {
    encoding: "utf8",
  });
  assert.match(entries, /src\/cli.js/);
  assert.ok(!entries.includes(".env"));
  assert.throws(() => packageRuntime(root, out), /OUTPUT_EXISTS/);
});
test("runtime packaging refuses uncommitted tracked changes", (t) => {
  const { root, out } = fixture(t);
  fs.writeFileSync(path.join(root, "src", "cli.js"), "changed");
  assert.throws(() => packageRuntime(root, out), /DIRTY_SOURCE/);
});
test("runtime packaging rejects tracked credential paths", (t) => {
  const { root, out, git } = fixture(t);
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "secret",
  ]);
  assert.throws(() => packageRuntime(root, out), /UNSAFE_TRACKED_PATH/);
});

for (const name of [".env.é", ".env.\tsecret", ".env.\nsecret"])
  test("rejects quoted credential path " + JSON.stringify(name), (t) => {
    if (process.platform === "win32" && /[\t\n]/.test(name)) {
      t.skip("Control characters invalid in Windows filenames");
      return;
    }
    const { root, out, git } = fixture(t);
    fs.writeFileSync(path.join(root, name), "PRIVATE");
    git(["add", "."]);
    git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "quoted secret",
    ]);
    assert.throws(() => packageRuntime(root, out), /UNSAFE_TRACKED_PATH/);
  });
