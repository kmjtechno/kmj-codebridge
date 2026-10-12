import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutopilotJournal } from "../src/autopilot.js";

const MINUTE = 60 * 1000;

function journal(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-autopilot-lease-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: Date.parse("2026-10-12T12:00:00.000Z") };
  const make = () =>
    new AutopilotJournal(dir, {
      leaseMs: 10 * MINUTE,
      now: () => clock.now,
      ...options,
    });
  return { journal: make(), clock, reopen: make };
}

test("claim returns a fencing token that status never reveals", (t) => {
  const { journal: j } = journal(t);
  j.enqueue({ project: "p1", key: "a", objective: "do a" });
  const claimed = j.claim("p1", { holder: "claude-chat-1" });
  assert.match(claimed.leaseToken, /^[0-9a-f-]{36}$/);
  assert.deepEqual(claimed.lease, {
    holder: "claude-chat-1",
    expiresAt: "2026-10-12T12:10:00.000Z",
  });
  const listed = j.status("p1").tasks[0];
  assert.equal(listed.lease.holder, "claude-chat-1");
  assert.equal(listed.lease.token, undefined);
  assert.equal(listed.leaseToken, undefined);
  assert.ok(!JSON.stringify(j.status("p1")).includes(claimed.leaseToken));
});

test("a disconnected holder's expired lease returns the task to the queue", (t) => {
  const { journal: j, clock } = journal(t);
  const task = j.enqueue({ project: "p1", key: "a", objective: "do a" });
  const first = j.claim("p1", { holder: "chatgpt-1" });
  assert.equal(j.claim("p1"), null, "leased task is not claimable twice");

  clock.now += 10 * MINUTE;
  const second = j.claim("p1", { holder: "claude-2" });
  assert.equal(second.id, task.id);
  assert.equal(second.attempts, 2);
  assert.equal(second.recoveries, 1);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(second.lease.holder, "claude-2");
});

test("a stale holder cannot checkpoint, pause or complete re-claimed work", (t) => {
  const { journal: j, clock } = journal(t);
  j.enqueue({ project: "p1", key: "a", objective: "do a" });
  const stale = j.claim("p1", { holder: "chat-old" });
  clock.now += 11 * MINUTE;
  const fresh = j.claim("p1", { holder: "chat-new" });

  assert.throws(
    () =>
      j.checkpoint(fresh.id, "p1", {
        summary: "x",
        next: "y",
        leaseToken: stale.leaseToken,
      }),
    /AUTOPILOT_LEASE_LOST/,
  );
  assert.throws(
    () => j.wait(fresh.id, "p1", "blocked", stale.leaseToken),
    /AUTOPILOT_LEASE_LOST/,
  );
  assert.throws(
    () =>
      j.complete(fresh.id, "p1", {
        state: "succeeded",
        result: "done",
        leaseToken: stale.leaseToken,
      }),
    /AUTOPILOT_LEASE_LOST/,
  );
  const done = j.complete(fresh.id, "p1", {
    state: "succeeded",
    result: "done",
    leaseToken: fresh.leaseToken,
  });
  assert.equal(done.state, "succeeded");
  assert.equal(done.lease, undefined, "terminal tasks hold no lease");
});

test("checkpoints renew the lease so active long work is not reclaimed", (t) => {
  const { journal: j, clock } = journal(t);
  j.enqueue({ project: "p1", key: "a", objective: "do a" });
  const claimed = j.claim("p1");
  for (let i = 0; i < 3; i++) {
    clock.now += 9 * MINUTE;
    const saved = j.checkpoint(claimed.id, "p1", {
      summary: `step ${i}`,
      next: "continue",
      leaseToken: claimed.leaseToken,
    });
    assert.equal(
      saved.lease.expiresAt,
      new Date(clock.now + 10 * MINUTE).toISOString(),
    );
  }
  assert.equal(j.claim("p1"), null, "27 minutes in, still held");
});

test("expired leases respect maxAttempts and fail dependents", (t) => {
  const { journal: j, clock } = journal(t, { maxAttempts: 2 });
  const parent = j.enqueue({ project: "p1", key: "parent", objective: "a" });
  const child = j.enqueue({
    project: "p1",
    key: "child",
    objective: "b",
    dependsOn: [parent.id],
  });
  j.claim("p1");
  clock.now += 10 * MINUTE;
  j.claim("p1");
  clock.now += 10 * MINUTE;
  assert.equal(j.claim("p1"), null);
  const byId = Object.fromEntries(
    j.status("p1").tasks.map((task) => [task.id, task]),
  );
  assert.equal(byId[parent.id].state, "failed");
  assert.equal(byId[parent.id].lastReason, "max_attempts_exceeded");
  assert.equal(byId[child.id].state, "failed");
});

test("leases are per project and never touch another project's work", (t) => {
  const { journal: j, clock } = journal(t);
  j.enqueue({ project: "p1", key: "a", objective: "a" });
  j.enqueue({ project: "p2", key: "a", objective: "a" });
  j.claim("p1");
  j.claim("p2");
  clock.now += 10 * MINUTE;
  j.claim("p1");
  const other = j.status("p2").tasks[0];
  assert.equal(other.state, "running");
  assert.equal(other.attempts, 1);
});

test("older clients without tokens keep working", (t) => {
  const { journal: j } = journal(t);
  j.enqueue({ project: "p1", key: "a", objective: "do a" });
  const claimed = j.claim("p1");
  j.checkpoint(claimed.id, "p1", { summary: "s", next: "n" });
  j.wait(claimed.id, "p1", "approval");
  j.resume(claimed.id, "p1");
  const again = j.claim("p1");
  assert.equal(
    j.complete(again.id, "p1", { state: "succeeded", result: "ok" }).state,
    "succeeded",
  );
});

test("lease state survives restart recovery and holder input is bounded", (t) => {
  const { journal: j, reopen } = journal(t);
  j.enqueue({ project: "p1", key: "a", objective: "do a" });
  j.claim("p1", { holder: "chat" });
  const restarted = reopen();
  const task = restarted.status("p1").tasks[0];
  assert.equal(task.state, "queued");
  assert.equal(task.lastReason, "agent_restart");
  assert.equal(task.lease, undefined);
  for (const holder of ["", "x".repeat(97), "bad\nnewline", 7])
    assert.throws(
      () => restarted.claim("p1", { holder }),
      /INVALID_AUTOPILOT_HOLDER/,
    );
});
