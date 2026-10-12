import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRunner } from "../src/jobs.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-job-atomic-"));
  const runner = new JobRunner(root);
  t.after(async () => {
    await runner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runner };
}

function record(id = "journal123") {
  return {
    id,
    project: "p1",
    key: "my-key",
    fingerprint: "f".repeat(64),
    gate: "build",
    state: "succeeded",
    queuedAt: "2026-10-12T00:00:00.000Z",
    startedAt: "2026-10-12T00:00:00.000Z",
    endedAt: "2026-10-12T00:00:01.000Z",
    exitCode: 0,
    output: "redacted result",
    truncated: false,
  };
}

test("journal persist ignores an attacker controlled legacy fixed temp symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlinks can require an administrator privilege");
    return;
  }
  const { root, runner } = fixture(t);
  const j = record();
  const target = path.join(root, j.id + ".json");
  const decoy = path.join(root, "important.txt");
  fs.writeFileSync(decoy, "preserve this file");
  fs.symlinkSync(decoy, target + ".tmp");
  runner.persist(j);
  assert.equal(fs.readFileSync(decoy, "utf8"), "preserve this file");
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).id, j.id);
  assert.equal(fs.lstatSync(target + ".tmp").isSymbolicLink(), true);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.startsWith(".")),
    [],
  );
});

test("journal persist refuses to overwrite a symlink target", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlinks can require an administrator privilege");
    return;
  }
  const { root, runner } = fixture(t);
  const j = record();
  const decoy = path.join(root, "important.txt");
  fs.writeFileSync(decoy, "unchanged");
  fs.symlinkSync(decoy, path.join(root, j.id + ".json"));
  assert.throws(() => runner.persist(j), /CORRUPT_JOURNAL/);
  assert.equal(fs.readFileSync(decoy, "utf8"), "unchanged");
});

test("journal persist refuses a hardlinked existing record", async (t) => {
  const { root, runner } = fixture(t);
  const j = record();
  runner.persist(j);
  const filename = path.join(root, j.id + ".json");
  const alias = path.join(root, "shared-copy.bin");
  fs.linkSync(filename, alias);
  const before = fs.readFileSync(filename, "utf8");
  j.output = "should never overwrite a hardlinked record";
  assert.throws(() => runner.persist(j), /CORRUPT_JOURNAL/);
  assert.equal(fs.readFileSync(alias, "utf8"), before);
  assert.equal(fs.readFileSync(filename, "utf8"), before);
});

test("journal writes survive reload with exact status and no temporary entries", async (t) => {
  const { root, runner } = fixture(t);
  const j = record();
  runner.persist(j);
  j.output = "updated redacted output";
  runner.persist(j);
  const entries = fs.readdirSync(root);
  assert.ok(entries.includes(j.id + ".json"));
  assert.equal(entries.filter((name) => name.startsWith(".")).length, 0);
  const reopened = new JobRunner(root);
  try {
    assert.equal(reopened.get(j.id, j.project).output, j.output);
    assert.equal(reopened.get(j.id, j.project).state, "succeeded");
    assert.throws(() => reopened.get(j.id, "other-tenant"), /JOB_NOT_FOUND/);
  } finally {
    await reopened.close();
  }
});

test("journal persistence rejects path-like IDs before creating any file", async (t) => {
  const { root, runner } = fixture(t);
  assert.throws(() => runner.persist(record("../outside")), /CORRUPT_JOURNAL/);
  assert.equal(fs.existsSync(path.join(root, "..", "outside.json")), false);
});

test("restart refuses two jobs with the same project and idempotency key", async (t) => {
  const { root, runner } = fixture(t);
  const first = record("first-id");
  const second = { ...record("second-id"), fingerprint: "a".repeat(64) };
  runner.persist(first);
  runner.persist(second);
  assert.throws(() => new JobRunner(root), /CORRUPT_JOURNAL/);
});

test("restart refuses a malformed idempotency key before accepting a job", async (t) => {
  const { root, runner } = fixture(t);
  const invalid = { ...record("bad-key-id"), key: "" };
  runner.persist(invalid);
  assert.throws(() => new JobRunner(root), /CORRUPT_JOURNAL/);
});
