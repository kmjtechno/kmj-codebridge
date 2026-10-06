import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";
import { FileCheckpoints } from "../src/checkpoints.js";
import { AuditLedger } from "../src/audit.js";
import { createDispatcher } from "../src/tools.js";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-checkpoints-"));
  const root = path.join(base, "project");
  const stateDir = path.join(base, "state");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "README.md"), "Version one");
  fs.writeFileSync(path.join(root, "settings.txt"), "token=confidential-key");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, stateDir, files: new ProjectFiles(root) };
}

test("checkpoint saves a bounded private file and detects drift without restoring", (t) => {
  const { root, stateDir, files } = fixture(t);
  const checkpoints = new FileCheckpoints(stateDir);
  const original = files.read("README.md");
  const saved = checkpoints.create(
    "p1",
    "create-one",
    "README.md",
    original.sha256,
    files,
    () => true,
  );
  assert.equal(saved.existing, false);
  assert.equal(saved.sha256, original.sha256);
  assert.equal(JSON.stringify(saved).includes("Version one"), false);
  assert.equal(
    checkpoints.create(
      "p1",
      "create-one",
      "README.md",
      original.sha256,
      files,
      () => true,
    ).existing,
    true,
  );
  assert.equal(
    checkpoints.restorePlan("p1", "create-one", files).unchanged,
    true,
  );

  files.write("README.md", "Version two", original.sha256);
  const plan = new FileCheckpoints(stateDir).restorePlan(
    "p1",
    "create-one",
    files,
  );
  assert.equal(plan.unchanged, false);
  assert.equal(plan.restoreAvailable, false);
  assert.equal(plan.nextAction, "REQUIRE_EXPLICIT_APPROVAL_FOR_ROLLBACK");
  assert.equal(
    fs.readFileSync(path.join(root, "README.md"), "utf8"),
    "Version two",
  );
  assert.ok(!JSON.stringify(plan).includes("Version one"));

  const privateDir = path.join(stateDir, "file-checkpoints", "p1");
  const snapshot = path.join(privateDir, saved.checkpoint + ".json");
  assert.ok(fs.existsSync(snapshot));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(privateDir).mode & 0o077, 0);
    assert.equal(fs.statSync(snapshot).mode & 0o077, 0);
  }
});

test("checkpoint rejects stale hashes, reuse conflicts, known secrets and protected paths", (t) => {
  const { root, stateDir, files } = fixture(t);
  const store = new FileCheckpoints(stateDir);
  const source = files.read("README.md");
  assert.throws(
    () =>
      store.create(
        "p1",
        "stale",
        "README.md",
        "0".repeat(64),
        files,
        () => true,
      ),
    /CONTENT_CONFLICT/,
  );
  assert.throws(
    () =>
      store.create(
        "p1",
        "hidden",
        "settings.txt",
        files.read("settings.txt").sha256,
        files,
        (content) => !content.includes("token="),
      ),
    /SENSITIVE_CONTENT_PROTECTED/,
  );
  assert.throws(
    () =>
      store.create("p1", "denied", ".env", source.sha256, files, () => true),
    /PATH_DENIED/,
  );
  fs.symlinkSync("README.md", path.join(root, "shortcut"));
  assert.throws(
    () =>
      store.create("p1", "link", "shortcut", source.sha256, files, () => true),
    /SYMLINK_DENIED/,
  );
  store.create("p1", "same", "README.md", source.sha256, files, () => true);
  assert.throws(
    () =>
      store.create(
        "p1",
        "same",
        "another.md",
        source.sha256,
        files,
        () => true,
      ),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () => store.restorePlan("p2", "same", files),
    /CHECKPOINT_NOT_FOUND/,
  );
});

test("checkpoint detects file tampering and refuses unsafe restoration planning", (t) => {
  const { stateDir, files } = fixture(t);
  const store = new FileCheckpoints(stateDir);
  const original = files.read("README.md");
  const saved = store.create(
    "p1",
    "tamper",
    "README.md",
    original.sha256,
    files,
    () => true,
  );
  const target = path.join(
    stateDir,
    "file-checkpoints",
    "p1",
    saved.checkpoint + ".json",
  );
  fs.writeFileSync(
    target,
    fs.readFileSync(target, "utf8").replace("Version one", "Version xxx"),
  );
  assert.throws(
    () => store.restorePlan("p1", "tamper", files),
    /CHECKPOINT_INVALID/,
  );
});

test("MCP checkpoint capture requires approved write scope and logs audit evidence", async (t) => {
  const { base, root, stateDir, files } = fixture(t);
  const audit = new AuditLedger(path.join(base, "audit"));
  const dispatcher = createDispatcher(
    {
      id: "d1",
      stateDir,
      projects: [{ id: "p1", root, writable: true, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({ features: ["read", "write"], limits: { concurrent_jobs: 1 } }),
    null,
    null,
    audit,
  );
  const args = {
    device: "d1",
    project: "p1",
    path: "README.md",
    requestKey: "checkpoint-safe",
    expectedHash: files.read("README.md").sha256,
  };
  await assert.rejects(
    dispatcher("checkpoint_create", args, ["read"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatcher("checkpoint_create", { ...args, project: "p2" }, ["write"]),
    /PROJECT_NOT_FOUND/,
  );
  const result = await dispatcher("checkpoint_create", args, ["write"]);
  assert.equal(result.path, "README.md");
  assert.equal(result.existing, false);
  const plan = await dispatcher(
    "checkpoint_restore_plan",
    { device: "d1", project: "p1", requestKey: "checkpoint-safe" },
    ["read"],
  );
  assert.equal(plan.unchanged, true);
  assert.equal(plan.restoreAvailable, false);
  const entries = audit.tail("p1", 4).entries;
  assert.deepEqual(
    entries.map((item) => [item.tool, item.phase, item.outcome]),
    [
      ["checkpoint_create", "attempt", "pending"],
      ["checkpoint_create", "result", "succeeded"],
    ],
  );
  assert.ok(!JSON.stringify(entries).includes("Version one"));
});
