import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";
import { AuditLedger } from "../src/audit.js";
import { createDispatcher } from "../src/tools.js";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-commander-write-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "README.md"), "safe project text");
  fs.writeFileSync(path.join(root, "existing.md"), "do not overwrite");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, ".ssh"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, files: new ProjectFiles(root) };
}

test("Commander create folder allows one approved directory and rejects unsafe paths", (t) => {
  const { root, files } = fixture(t);
  const created = files.createDirectory("docs");
  assert.deepEqual(created, { path: "docs", created: true });
  assert.equal(fs.statSync(path.join(root, "docs")).isDirectory(), true);
  assert.throws(
    () => files.createDirectory("docs"),
    /NOT_REGULAR_FILE|DIRECTORY_EXISTS/,
  );
  assert.throws(() => files.createDirectory("../outside"), /INVALID_PATH/);
  assert.throws(() => files.createDirectory(".ssh/private"), /PATH_DENIED/);
  assert.throws(() => files.createDirectory("node_modules/new"), /PATH_DENIED/);
  assert.throws(() => files.createDirectory("missing/child"), /FILE_NOT_FOUND/);
});

test("Commander move never overwrites a file or accepts stale content", (t) => {
  const { root, files } = fixture(t);
  const before = files.read("README.md");
  files.createDirectory("docs");
  assert.throws(
    () => files.moveFile("README.md", "existing.md", before.sha256),
    /DESTINATION_EXISTS/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "existing.md"), "utf8"),
    "do not overwrite",
  );
  assert.throws(
    () => files.moveFile("README.md", "docs/renamed.md", "0".repeat(64)),
    /CONTENT_CONFLICT/,
  );
  assert.equal(fs.existsSync(path.join(root, "docs", "renamed.md")), false);
  const moved = files.moveFile("README.md", "docs/renamed.md", before.sha256);
  assert.deepEqual(moved, {
    from: "README.md",
    to: "docs/renamed.md",
    sha256: before.sha256,
    bytes: before.bytes,
    moved: true,
  });
  assert.equal(fs.existsSync(path.join(root, "README.md")), false);
  assert.equal(
    fs.readFileSync(path.join(root, "docs", "renamed.md"), "utf8"),
    before.content,
  );
});

test("Commander move does not follow symlinks or move hardlinked and secret paths", (t) => {
  const { root, files } = fixture(t);
  const hash = files.read("README.md").sha256;
  fs.symlinkSync("README.md", path.join(root, "shortcut"));
  fs.linkSync(path.join(root, "README.md"), path.join(root, "linked"));
  assert.throws(() => files.moveFile("shortcut", "x", hash), /SYMLINK_DENIED/);
  assert.throws(
    () => files.moveFile("README.md", "x", hash),
    /HARDLINK_DENIED/,
  );
  assert.throws(
    () => files.moveFile("README.md", "../outside", hash),
    /INVALID_PATH/,
  );
  assert.throws(
    () => files.moveFile("README.md", "node_modules/x", hash),
    /PATH_DENIED/,
  );
  assert.throws(() => files.moveFile(".env", "new.md", hash), /PATH_DENIED/);
});

test("Commander write tools inherit project permissions and audit attempt/result evidence", async (t) => {
  const { base, root } = fixture(t);
  const audit = new AuditLedger(path.join(base, "audit"));
  const runner = { maxConcurrent: 1 };
  const scope = { device: "d1", project: "p1" };
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: true, gates: {}, commands: {} }],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
    null,
    null,
    audit,
  );
  await assert.rejects(
    dispatch("create_project_directory", { ...scope, path: "docs" }, ["read"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch(
      "move_project_file",
      {
        ...scope,
        from: "README.md",
        to: "renamed.md",
        expectedHash: "0".repeat(64),
      },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
  assert.equal(fs.existsSync(path.join(root, "docs")), false);

  await dispatch("create_project_directory", { ...scope, path: "docs" }, [
    "write",
  ]);
  const before = new ProjectFiles(root).read("README.md");
  await dispatch(
    "move_project_file",
    {
      ...scope,
      from: "README.md",
      to: "docs/renamed.md",
      expectedHash: before.sha256,
    },
    ["write"],
  );
  const status = audit.status("p1");
  assert.equal(status.events, 4);
  const tail = audit.tail("p1", 4).entries;
  assert.deepEqual(
    tail.map((entry) => [entry.tool, entry.phase, entry.outcome]),
    [
      ["create_project_directory", "attempt", "pending"],
      ["create_project_directory", "result", "succeeded"],
      ["move_project_file", "attempt", "pending"],
      ["move_project_file", "result", "succeeded"],
    ],
  );
  assert.ok(!JSON.stringify(tail).includes("renamed.md"));
  await assert.rejects(
    dispatch(
      "create_project_directory",
      { ...scope, project: "p2", path: "other" },
      ["write"],
    ),
    /PROJECT_NOT_FOUND/,
  );
});
