import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JobRunner } from "../src/jobs.js";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-queue-heal-"));
  const runner = new JobRunner(path.join(root, "jobs"), options);
  t.after(async () => {
    await runner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runner };
}

function request(root, project, key, script = "") {
  return {
    project,
    gate: "unit",
    key,
    cwd: root,
    command: process.execPath,
    args: ["-e", script],
    timeoutMs: 8000,
  };
}

async function until(predicate, message) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail(message);
}

const healthy = () => ({
  cpuCount: 8,
  loadOne: 0,
  totalMemoryBytes: 8 * 1024 ** 3,
  freeMemoryBytes: 4 * 1024 ** 3,
  freeDiskBytes: 20 * 1024 ** 3,
});

test("resource-paused queue resumes without MCP polling or replaying the first job", async (t) => {
  let pressure = false;
  const { root, runner } = fixture(t, {
    maxConcurrent: 1,
    recheckIntervalMs: 25,
    resourceProbe: () => ({
      ...healthy(),
      freeMemoryBytes: pressure ? 64 * 1024 ** 2 : 4 * 1024 ** 3,
    }),
  });
  const first = runner.run(
    request(root, "p1", "first", "setTimeout(()=>{},300)"),
  );
  const second = runner.run(
    request(root, "p1", "second", 'console.log("resumed")'),
  );
  assert.equal(second.state, "queued");
  pressure = true;
  // Observe the internal journal only: public get/list would itself call drain().
  await until(
    () => runner.jobs.get(first.id).state === "succeeded",
    "first job did not finish",
  );
  assert.equal(runner.jobs.get(second.id).state, "queued");
  assert.ok(runner.recheckTimer, "queued work must schedule its own wakeup");
  pressure = false;
  await until(
    () => runner.jobs.get(second.id).state === "succeeded",
    "queued job did not self-resume",
  );
  assert.match(runner.jobs.get(second.id).output, /resumed/);
  assert.equal(runner.jobs.get(first.id).state, "succeeded");
  assert.equal(runner.recheckTimer, null);
});

test("temporary resource-probe failures recover without a new request", async (t) => {
  let probeFails = false;
  const { root, runner } = fixture(t, {
    maxConcurrent: 1,
    recheckIntervalMs: 25,
    resourceProbe: () => {
      if (probeFails) throw Error("transient statfs failure");
      return healthy();
    },
  });
  const first = runner.run(
    request(root, "p1", "probe-first", "setTimeout(()=>{},250)"),
  );
  const second = runner.run(
    request(root, "p1", "probe-second", 'console.log("recovered")'),
  );
  probeFails = true;
  await until(
    () => runner.jobs.get(first.id).state === "succeeded",
    "first job did not finish",
  );
  assert.equal(runner.jobs.get(second.id).state, "queued");
  probeFails = false;
  await until(
    () => runner.jobs.get(second.id).state === "succeeded",
    "resource probe did not recover",
  );
  assert.match(runner.jobs.get(second.id).output, /recovered/);
});

test("queue diagnostics are scoped, bounded and hide idempotency keys", async (t) => {
  const { root, runner } = fixture(t, { maxConcurrent: 1 });
  const first = runner.run(
    request(root, "p1", "private-key-1", "setTimeout(()=>{},1500)"),
  );
  const second = runner.run(request(root, "p2", "private-key-2"));
  const third = runner.run(request(root, "p1", "private-key-3"));
  assert.equal(runner.get(second.id, "p2").queuePosition, 1);
  assert.equal(runner.get(third.id, "p1").queuePosition, 1);
  assert.equal(runner.get(first.id, "p1").queuePosition, null);

  const p1 = runner.list("p1", 10);
  const p2 = runner.list("p2", 10);
  assert.equal(p1.summary.running, 1);
  assert.equal(p1.summary.queued, 1);
  assert.equal(p2.summary.running, 0);
  assert.equal(p2.summary.queued, 1);
  assert.equal(p2.total, 1);
  assert.equal(p1.jobs.find((j) => j.id === third.id).queuePosition, 1);
  assert.equal(p1.jobs.find((j) => j.id === first.id).durationMs >= 0, true);
  assert.equal(runner.capacity(root).journalUsed, 3);
  assert.equal(runner.capacity(root).journalRemaining, 997);
  assert.equal(runner.capacity(root).queueLimit, 64);
  assert.ok(!JSON.stringify({ p1, p2 }).includes("private-key"));
  assert.ok(!JSON.stringify(p1).includes(second.id));

  assert.equal(runner.cancel(second.id, "p2").state, "cancelled");
  assert.equal(runner.cancel(third.id, "p1").state, "cancelled");
  runner.cancel(first.id, "p1");
  await until(
    () => runner.jobs.get(first.id).state === "cancelled",
    "first job was not cancelled",
  );
  assert.equal(runner.recheckTimer, null);
});

test("closing the runner cancels queue wakeups and forbids new execution", async (t) => {
  const { root, runner } = fixture(t, {
    recheckIntervalMs: 25,
    resourceProbe: healthy,
  });
  const first = runner.run(
    request(root, "p1", "close-first", "setTimeout(()=>{},1500)"),
  );
  const queued = runner.run(request(root, "p1", "close-queued"));
  assert.equal(queued.state, "queued");
  await runner.close();
  assert.equal(runner.recheckTimer, null);
  assert.equal(runner.jobs.get(queued.id).state, "interrupted");
  assert.equal(runner.jobs.get(first.id).state, "interrupted");
  assert.throws(
    () => runner.run(request(root, "p1", "after-close")),
    /JOB_RUNNER_CLOSED/,
  );
});

test("invalid queue recheck configuration fails closed", () => {
  assert.throws(
    () => new JobRunner("unused", { recheckIntervalMs: 0 }),
    /INVALID_JOB_RECHECK_INTERVAL/,
  );
});
