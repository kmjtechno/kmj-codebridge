import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-commander-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, ".ssh"));
  fs.writeFileSync(path.join(root, "README.md"), "Project introduction");
  fs.writeFileSync(path.join(root, "src", "main.ts"), "export const value = 1;");
  fs.writeFileSync(path.join(root, ".env"), "token=private");
  fs.writeFileSync(path.join(root, ".ssh", "config"), "private");
  fs.writeFileSync(path.join(root, "node_modules", "library.js"), "hidden");
  fs.symlinkSync(path.join(root, "src"), path.join(root, "shortcut"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, files: new ProjectFiles(root) };
}

test("Commander folder tree is bounded and excludes secrets and symlinks", (t) => {
  const { files } = fixture(t);
  const result = files.tree("", 3, 100);
  assert.ok(result.entries.some((entry) => entry.path === "src/main.ts"));
  assert.ok(result.entries.some((entry) => entry.path === "README.md"));
  assert.ok(!JSON.stringify(result).includes(".env"));
  assert.ok(!JSON.stringify(result).includes(".ssh"));
  assert.ok(!JSON.stringify(result).includes("node_modules"));
  assert.ok(!JSON.stringify(result).includes("shortcut"));
  assert.equal(result.truncated, false);
  assert.deepEqual(files.tree("src", 0, 10).entries, [
    { path: "src/main.ts", type: "file", depth: 0 },
  ]);
});

test("Commander folder tree rejects traversal and always bounds output", (t) => {
  const { files } = fixture(t);
  assert.throws(() => files.tree("../", 2, 100), /INVALID_PATH/);
  assert.throws(() => files.tree(".ssh", 2, 100), /INVALID_PATH/);
  assert.throws(() => files.tree("", 6, 100), /INVALID_TREE_LIMIT/);
  assert.throws(() => files.tree("", 1, 201), /INVALID_TREE_LIMIT/);
  const limited = files.tree("", 2, 1);
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.truncated, true);
});

test("Commander file info returns metadata only and rejects sensitive and linked paths", (t) => {
  const { root, files } = fixture(t);
  const metadata = files.fileInfo("src/main.ts");
  assert.equal(metadata.path, "src/main.ts");
  assert.equal(metadata.bytes, Buffer.byteLength("export const value = 1;"));
  assert.match(metadata.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(metadata).includes("export const"), false);
  assert.throws(() => files.fileInfo(".env"), /PATH_DENIED/);
  assert.throws(() => files.fileInfo("shortcut/main.ts"), /INVALID_PATH|SYMLINK_DENIED/);
  fs.linkSync(path.join(root, "README.md"), path.join(root, "linked.md"));
  assert.throws(() => files.fileInfo("linked.md"), /HARDLINK_DENIED/);
});

test("Commander job sessions are project-scoped, sorted, bounded and redacted by design", async (t) => {
  const { base, root } = fixture(t);
  const jobsDir = path.join(base, "jobs");
  const runner = new JobRunner(jobsDir);
  t.after(async () => runner.close());

  runner.jobs.set("a1", {
    id: "a1",
    project: "p1",
    gate: "unit",
    state: "succeeded",
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: "2026-10-01T00:00:01.000Z",
    exitCode: 0,
    output: "secret=do-not-disclose",
    key: "private-idempotency-key",
    truncated: false,
  });
  runner.jobs.set("b2", {
    id: "b2",
    project: "p2",
    gate: "private",
    state: "failed",
    startedAt: "2026-10-02T00:00:00.000Z",
    endedAt: null,
    exitCode: 1,
    output: "another-tenant-data",
    truncated: true,
  });
  runner.jobs.set("c3", {
    id: "c3",
    project: "p1",
    gate: "build",
    state: "running",
    startedAt: "2026-10-03T00:00:00.000Z",
    endedAt: null,
    exitCode: null,
    output: "token=do-not-disclose",
    truncated: false,
  });

  const config = {
    id: "d1",
    stateDir: path.join(base, "state"),
    projects: [{ id: "p1", root, writable: true, gates: {}, commands: {} }],
  };
  const dispatch = createDispatcher(
    config,
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  const scope = { device: "d1", project: "p1" };
  const sessions = await dispatch("list_project_jobs", { ...scope, limit: 1 }, ["read"]);
  assert.equal(sessions.total, 2);
  assert.equal(sessions.jobs.length, 1);
  assert.equal(sessions.jobs[0].id, "c3");
  assert.ok(!JSON.stringify(sessions).includes("secret"));
  assert.ok(!JSON.stringify(sessions).includes("another-tenant-data"));
  assert.ok(!JSON.stringify(sessions).includes("idempotency"));
  assert.equal((await dispatch("project_tree", { ...scope, maxDepth: 2, maxEntries: 30 }, ["read"])).path, "");
  assert.equal(
    (await dispatch("project_file_info", { ...scope, path: "README.md" }, ["read"])).type,
    "file",
  );
  await assert.rejects(
    dispatch("list_project_jobs", { ...scope, project: "p2" }, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
  await assert.rejects(
    dispatch("project_tree", scope, ["write"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("project_tree", { ...scope, maxEntries: 500 }, ["read"]),
    /too_big|INVALID|validation|at most/i,
  );
});
