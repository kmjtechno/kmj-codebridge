import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { JobRunner } from "../src/jobs.js";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-archive-"));
  const runner = new JobRunner(root, {
    journalLimit: 3,
    archiveMaxEntries: 10000,
    ...options,
  });
  t.after(async () => {
    await runner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runner };
}

function request(root, key, project = "p1", script = 'console.log("done")') {
  return {
    project,
    gate: "test",
    key,
    cwd: root,
    command: process.execPath,
    args: ["-e", script],
    timeoutMs: 10000,
  };
}

async function finish(runner, id, project = "p1") {
  for (let i = 0; i < 500; i++) {
    const job = runner.get(id, project);
    if (!["running", "queued"].includes(job.state)) return job;
    await delay(10);
  }
  assert.fail("job did not complete");
}

test("archived jobs retain request-key idempotency through restart", async (t) => {
  const { root, runner } = fixture(t);
  const marker = path.join(root, "execution-marker.txt");
  const script = 'require("node:fs").appendFileSync(' + JSON.stringify(marker) + ', "x")';
  const original = request(root, "same-key", "p1", script);
  const first = runner.run(original);
  await finish(runner, first.id);
  for (const key of ["second", "third"]) {
    const job = runner.run(request(root, key));
    await finish(runner, job.id);
  }
  const before = fs.readFileSync(marker, "utf8");
  const next = runner.run(request(root, "fourth"));
  await finish(runner, next.id);
  assert.ok(runner.capacity(root).archiveUsed >= 2);
  const archived = runner.run(original);
  assert.equal(archived.id, first.id);
  assert.equal(archived.archived, true);
  assert.equal(archived.outputAvailable, false);
  assert.equal(archived.output, "");
  assert.equal(fs.readFileSync(marker, "utf8"), before);
  assert.throws(
    () => runner.run({ ...original, args: ["-e", 'console.log("changed")'] }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(() => runner.get(first.id, "another-tenant"), /JOB_NOT_FOUND/);
  assert.ok(runner.list("p1").archivedJobs >= 2);
  await runner.close();
  const restart = new JobRunner(root, { journalLimit: 3 });
  try {
    assert.equal(restart.run(original).id, first.id);
    assert.equal(restart.get(first.id, "p1").archived, true);
    assert.equal(fs.readFileSync(marker, "utf8"), before);
  } finally {
    await restart.close();
  }
});

test("queued and running work cannot be compacted", async (t) => {
  const { root, runner } = fixture(t, { journalLimit: 2, maxConcurrent: 2 });
  const active = runner.run(request(root, "active", "p1", "setTimeout(()=>{},1200)"));
  const terminal = runner.run(request(root, "terminal"));
  await finish(runner, terminal.id);
  assert.equal(runner.get(active.id, "p1").state, "running");
  const third = runner.run(request(root, "third"));
  assert.equal(runner.get(active.id, "p1").archived, undefined);
  assert.ok(fs.existsSync(path.join(root, active.id + ".json")));
  assert.equal(runner.get(terminal.id, "p1").archived, true);
  await finish(runner, third.id);
  runner.cancel(active.id, "p1");
  await finish(runner, active.id);
});

test("archive corruption and hardlinks fail closed", async (t) => {
  const { root, runner } = fixture(t, { journalLimit: 1 });
  const first = runner.run(request(root, "a"));
  await finish(runner, first.id);
  const second = runner.run(request(root, "b"));
  await finish(runner, second.id);
  const file = path.join(root, "job-archive", first.id + ".entry");
  const saved = fs.readFileSync(file);
  const modified = JSON.parse(saved.toString("utf8"));
  modified.record.state = "failed";
  fs.writeFileSync(file, JSON.stringify(modified));
  assert.throws(
    () => new JobRunner(root, { journalLimit: 1 }),
    /CORRUPT_JOB_ARCHIVE/,
  );
  fs.writeFileSync(file, saved);
  const link = path.join(root, "job-archive", "hardlink.bin");
  fs.linkSync(file, link);
  assert.throws(
    () => new JobRunner(root, { journalLimit: 1 }),
    /CORRUPT_JOB_ARCHIVE/,
  );
  fs.unlinkSync(link);
  const restart = new JobRunner(root, { journalLimit: 1 });
  await restart.close();
});

test("missing HMAC key blocks startup without re-execution", async (t) => {
  const { root, runner } = fixture(t, { journalLimit: 1 });
  const first = runner.run(request(root, "a"));
  await finish(runner, first.id);
  const second = runner.run(request(root, "b"));
  await finish(runner, second.id);
  fs.unlinkSync(path.join(root, "job-archive", ".hmac-key"));
  assert.throws(
    () => new JobRunner(root, { journalLimit: 1 }),
    /CORRUPT_JOB_ARCHIVE/,
  );
});

test("archive capacity exhaustion preserves existing idempotency", async (t) => {
  const { root, runner } = fixture(t, {
    journalLimit: 1,
    archiveMaxEntries: 1,
  });
  const a = runner.run(request(root, "a"));
  await finish(runner, a.id);
  const b = runner.run(request(root, "b"));
  await finish(runner, b.id);
  assert.equal(runner.capacity(root).archiveUsed, 1);
  assert.throws(() => runner.run(request(root, "c")), /JOB_ARCHIVE_FULL/);
  assert.equal(runner.run(request(root, "a")).id, a.id);
  assert.equal(runner.run(request(root, "b")).id, b.id);
  assert.equal(runner.capacity(root).journalUsed, 1);
});

test("crash after tombstone sync but before journal removal is recoverable", async (t) => {
  const { root, runner } = fixture(t, { journalLimit: 1 });
  const original = request(root, "a");
  const a = runner.run(original);
  await finish(runner, a.id);
  const journal = JSON.stringify(runner.jobs.get(a.id));
  const b = runner.run(request(root, "b"));
  await finish(runner, b.id);
  fs.writeFileSync(path.join(root, a.id + ".json"), journal, { mode: 0o600 });
  await runner.close();
  const restart = new JobRunner(root, { journalLimit: 1 });
  try {
    assert.equal(restart.run(original).id, a.id);
    assert.equal(restart.get(a.id, "p1").state, "succeeded");
    assert.equal(restart.get(a.id, "p1").archived, undefined);
    assert.throws(() => restart.get(a.id, "p2"), /JOB_NOT_FOUND/);
  } finally {
    await restart.close();
  }
});

test("over 1000 terminal journal records compact without lost replay evidence", async (t) => {
  const { root, runner } = fixture(t, { journalLimit: 1000 });
  const stamp = new Date("2026-10-07T12:00:00.000Z").toISOString();
  for (let i = 0; i < 1005; i++) {
    const id = "seed-" + i;
    const spec = request(root, "historic-" + i);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      project: spec.project,
      gate: spec.gate,
      cwd: spec.cwd,
      command: spec.command,
      args: spec.args,
      timeoutMs: spec.timeoutMs,
    })).digest("hex");
    const entry = {
      id, project: "p1", gate: "test", key: spec.key, fingerprint,
      state: "succeeded", queuedAt: stamp, startedAt: stamp,
      endedAt: stamp, exitCode: 0, output: "redacted terminal log",
      truncated: false,
    };
    fs.writeFileSync(path.join(root, id + ".json"), JSON.stringify(entry), { mode: 0o600 });
  }
  const seeded = new JobRunner(root, { journalLimit: 1000 });
  try {
    const newer = seeded.run(request(root, "after-1000"));
    await finish(seeded, newer.id);
    assert.ok(seeded.capacity(root).journalUsed <= 701);
    assert.ok(seeded.capacity(root).archiveUsed >= 305);
    const old = seeded.run(request(root, "historic-0"));
    assert.equal(old.id, "seed-0");
    assert.equal(old.archived, true);
    assert.equal(seeded.list("p2").archivedJobs, 0);
  } finally {
    await seeded.close();
  }
});

test("unexpected archive directory entries fail closed", async (t) => {
  const { root, runner } = fixture(t, { journalLimit: 1 });
  const a = runner.run(request(root, "a"));
  await finish(runner, a.id);
  const b = runner.run(request(root, "b"));
  await finish(runner, b.id);
  fs.writeFileSync(path.join(root, "job-archive", "unexpected"), "invalid");
  assert.throws(
    () => new JobRunner(root, { journalLimit: 1 }),
    /CORRUPT_JOB_ARCHIVE/,
  );
});
