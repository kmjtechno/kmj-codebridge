import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles, hash } from "../src/policy.js";
import { createDispatcher } from "../src/tools.js";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-tail-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, "progress.log"),
    "first\nsecond\nsecret=private123\nfourth\nfifth",
  );
  fs.writeFileSync(path.join(root, ".env"), "token=protected");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { root, base, files: new ProjectFiles(root) };
}

test("tail returns bounded recent lines and exact file hash", (t) => {
  const { files } = fixture(t);
  const r = files.readTail("progress.log", 2);
  assert.equal(r.content, "fourth\nfifth");
  assert.equal(r.startLine, 4);
  assert.equal(r.totalLines, 5);
  assert.equal(r.linesReturned, 2);
  assert.equal(
    r.sha256,
    hash("first\nsecond\nsecret=private123\nfourth\nfifth"),
  );
  assert.equal(r.contentTruncated, false);
});

test("tail supports one long line without returning unbounded data", (t) => {
  const { files, root } = fixture(t);
  fs.writeFileSync(path.join(root, "long.log"), "A".repeat(50000));
  const r = files.readTail("long.log", 1);
  assert.equal(r.content.length, 8192);
  assert.equal(r.contentTruncated, true);
  assert.equal(r.totalLines, 1);
  assert.equal(r.linesReturned, 1);
  assert.throws(() => files.readTail("long.log", 201), /INVALID_TAIL_LIMIT/);
  assert.throws(() => files.readTail("long.log", 0), /INVALID_TAIL_LIMIT/);
});

test("tail rejects private files, links and oversized reads", (t) => {
  const { files, root } = fixture(t);
  assert.throws(() => files.readTail(".env", 2), /PATH_DENIED/);
  assert.throws(() => files.readTail("../outside", 2), /INVALID_PATH/);
  fs.symlinkSync("progress.log", path.join(root, "alias.log"));
  assert.throws(() => files.readTail("alias.log", 2), /SYMLINK_DENIED/);
  fs.linkSync(path.join(root, "progress.log"), path.join(root, "hardlink.log"));
  assert.throws(
    () => files.readTail("hardlink.log", 2),
    /HARDLINK_DENIED|NOT_REGULAR_FILE/,
  );
  fs.writeFileSync(path.join(root, "huge.log"), "X".repeat(262145));
  assert.throws(() => files.readTail("huge.log", 2), /FILE_TOO_LARGE/);
});

test("tail redacts secrets and enforces read authorization", async (t) => {
  const { root, base } = fixture(t);
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
  );
  const scope = { device: "d1", project: "p1" };
  const r = await dispatch(
    "read_file_tail",
    { ...scope, path: "progress.log", maxLines: 3 },
    ["read"],
  );
  assert.equal(r.redacted, true);
  assert.ok(!r.content.includes("private123"));
  assert.ok(r.content.includes("fourth"));
  await assert.rejects(
    dispatch("read_file_tail", { ...scope, path: "progress.log" }, ["write"]),
    /ACCESS_DENIED/,
  );
  const wrongDevice = { ...scope, device: "d2", path: "progress.log" };
  const wrongProject = { ...scope, project: "p2", path: "progress.log" };
  await assert.rejects(
    dispatch("read_file_tail", wrongDevice, ["read"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("read_file_tail", wrongProject, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
});
