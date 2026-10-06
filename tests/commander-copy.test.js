import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles, hash } from "../src/policy.js";
import { AuditLedger } from "../src/audit.js";
import { createDispatcher } from "../src/tools.js";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-commander-copy-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "README.md"), "Keep original intact");
  fs.writeFileSync(path.join(root, "existing.md"), "do not overwrite");
  fs.writeFileSync(path.join(root, "asset.bin"), Buffer.from([0, 2, 255]));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, files: new ProjectFiles(root) };
}

test("Commander copy duplicates a verified file without touching source", (t) => {
  const { root, files } = fixture(t);
  const source = files.read("README.md");
  const result = files.copyFile(
    "README.md",
    "docs/duplicate.md",
    source.sha256,
  );
  assert.deepEqual(result, {
    from: "README.md",
    to: "docs/duplicate.md",
    sha256: source.sha256,
    bytes: source.bytes,
    copied: true,
  });
  assert.equal(
    fs.readFileSync(path.join(root, "README.md"), "utf8"),
    source.content,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "docs/duplicate.md"), "utf8"),
    source.content,
  );
});

test("Commander copy permits bounded binary files but never overwrites", (t) => {
  const { root, files } = fixture(t);
  const bytes = fs.readFileSync(path.join(root, "asset.bin"));
  const result = files.copyFile(
    "asset.bin",
    "docs/asset-copy.bin",
    hash(bytes),
  );
  assert.equal(result.bytes, 3);
  assert.deepEqual(
    fs.readFileSync(path.join(root, "docs/asset-copy.bin")),
    bytes,
  );
  assert.throws(
    () => files.copyFile("asset.bin", "docs/asset-copy.bin", hash(bytes)),
    /DESTINATION_EXISTS/,
  );
  assert.throws(
    () => files.copyFile("asset.bin", "existing.md", hash(bytes)),
    /DESTINATION_EXISTS/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "existing.md"), "utf8"),
    "do not overwrite",
  );
});

test("Commander copy rejects stale hashes, secret paths, symlinks and traversal", (t) => {
  const { root, files } = fixture(t);
  const original = files.read("README.md");
  assert.throws(
    () => files.copyFile("README.md", "docs/duplicate.md", "0".repeat(64)),
    /CONTENT_CONFLICT/,
  );
  assert.equal(fs.existsSync(path.join(root, "docs/duplicate.md")), false);
  assert.throws(
    () => files.copyFile("README.md", "../outside", original.sha256),
    /INVALID_PATH/,
  );
  assert.throws(
    () => files.copyFile(".env", "docs/copied", original.sha256),
    /PATH_DENIED/,
  );
  assert.throws(
    () => files.copyFile("README.md", "node_modules/secret", original.sha256),
    /PATH_DENIED/,
  );
  fs.symlinkSync("README.md", path.join(root, "shortcut"));
  assert.throws(
    () => files.copyFile("shortcut", "docs/x", original.sha256),
    /SYMLINK_DENIED/,
  );
  fs.symlinkSync("README.md", path.join(root, "destination"));
  assert.throws(
    () => files.copyFile("README.md", "destination", original.sha256),
    /SYMLINK_DENIED/,
  );
  fs.linkSync(path.join(root, "README.md"), path.join(root, "linked.md"));
  assert.throws(
    () => files.copyFile("README.md", "docs/y", original.sha256),
    /HARDLINK_DENIED/,
  );
});

test("Commander copy requires write access, inherits tenant/project scope and records audit", async (t) => {
  const { base, root } = fixture(t);
  const audit = new AuditLedger(path.join(base, "audit"));
  const scope = { device: "d1", project: "p1" };
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
    null,
    null,
    audit,
  );
  const input = {
    ...scope,
    from: "README.md",
    to: "docs/copied.md",
    expectedHash: new ProjectFiles(root).read("README.md").sha256,
  };
  await assert.rejects(
    dispatch("copy_project_file", input, ["read"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("copy_project_file", { ...input, device: "d2" }, ["write"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("copy_project_file", { ...input, project: "p2" }, ["write"]),
    /PROJECT_NOT_FOUND/,
  );
  assert.equal(fs.existsSync(path.join(root, "docs/copied.md")), false);
  const result = await dispatch("copy_project_file", input, ["write"]);
  assert.equal(result.copied, true);
  assert.equal(fs.existsSync(path.join(root, "README.md")), true);
  const entries = audit.tail("p1", 10).entries;
  assert.deepEqual(
    entries.map((item) => [item.tool, item.phase, item.outcome]),
    [
      ["copy_project_file", "attempt", "pending"],
      ["copy_project_file", "result", "succeeded"],
    ],
  );
  assert.ok(!JSON.stringify(entries).includes("docs/copied.md"));
});
