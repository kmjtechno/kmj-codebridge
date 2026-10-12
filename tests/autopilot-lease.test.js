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

// A task claimed under lease-aware code must be fenced: a missing token is
// exactly as unsafe as a stale one (it would let any caller, not just a
// prior holder, silently act on another holder's claimed work).
test("a leased task rejects tokenless checkpoint, wait and complete", (t) => {
  const { journal: j } = journal(t);
  j.enqueue({ project: "p1", key: "a", objective: "do a" });
  const claimed = j.claim("p1");
  assert.throws(
    () => j.checkpoint(claimed.id, "p1", { summary: "s", next: "n" }),
    /AUTOPILOT_LEASE_LOST/,
  );
  assert.throws(
    () => j.wait(claimed.id, "p1", "approval"),
    /AUTOPILOT_LEASE_LOST/,
  );
  assert.throws(
    () => j.complete(claimed.id, "p1", { state: "succeeded", result: "ok" }),
    /AUTOPILOT_LEASE_LOST/,
  );
  // The real holder, token in hand, still works end to end.
  j.checkpoint(claimed.id, "p1", {
    summary: "s",
    next: "n",
    leaseToken: claimed.leaseToken,
  });
  j.wait(claimed.id, "p1", "approval", claimed.leaseToken);
  j.resume(claimed.id, "p1");
  const again = j.claim("p1");
  assert.throws(
    () => j.complete(again.id, "p1", { state: "succeeded", result: "ok" }),
    /AUTOPILOT_LEASE_LOST/,
  );
  assert.equal(
    j.complete(again.id, "p1", {
      state: "succeeded",
      result: "ok",
      leaseToken: again.leaseToken,
    }).state,
    "succeeded",
  );
});

// Compatibility is for a genuinely legacy task only: one still `running`
// from before this feature existed, with no `lease` and no `leasedEver`
// (what a journal loaded from an older binary's state file would contain,
// before that task is ever touched by lease-aware claim() again).
test("a genuinely legacy running task (no lease, never claimed under this code) keeps working without a token", (t) => {
  const { journal: j, clock } = journal(t);
  const now = new Date(clock.now).toISOString();
  j.state.tasks.push({
    id: "legacy-task-1",
    project: "p1",
    key: "legacy",
    objective: "pre-upgrade work",
    priority: 0,
    dependsOn: [],
    fingerprint: "legacy",
    state: "running",
    attempts: 1,
    recoveries: 0,
    checkpoint: null,
    lastReason: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  });

  j.checkpoint("legacy-task-1", "p1", { summary: "s", next: "n" });
  j.wait("legacy-task-1", "p1", "blocked");
  j.resume("legacy-task-1", "p1");

  // The moment it is claimed by lease-aware code, it is fenced like any
  // other task from then on.
  const reclaimed = j.claim("p1");
  assert.equal(reclaimed.id, "legacy-task-1");
  assert.ok(reclaimed.leaseToken);
  assert.throws(
    () => j.complete(reclaimed.id, "p1", { state: "succeeded", result: "ok" }),
    /AUTOPILOT_LEASE_LOST/,
  );
  assert.equal(
    j.complete(reclaimed.id, "p1", {
      state: "succeeded",
      result: "ok",
      leaseToken: reclaimed.leaseToken,
    }).state,
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

test("an expired holder cannot renew or finish before another worker reclaims", (t) => {
  const { journal: j, clock } = journal(t);
  j.enqueue({ project: "p1", key: "late", objective: "Do bounded work" });
  const expired = j.claim("p1", { holder: "chat-old" });
  clock.now += 10 * MINUTE;
  assert.throws(
    () =>
      j.checkpoint(expired.id, "p1", {
        summary: "unauthorized renewal",
        next: "done",
        leaseToken: expired.leaseToken,
      }),
    /AUTOPILOT_LEASE_LOST/,
  );
  assert.throws(
    () => j.wait(expired.id, "p1", "pause", expired.leaseToken),
    /AUTOPILOT_LEASE_LOST/,
  );
  assert.throws(
    () =>
      j.complete(expired.id, "p1", {
        state: "succeeded",
        result: "old holder finished",
        leaseToken: expired.leaseToken,
      }),
    /AUTOPILOT_LEASE_LOST/,
  );
  const claimed = j.claim("p1", { holder: "chat-new" });
  assert.notEqual(claimed.leaseToken, expired.leaseToken);
  assert.equal(
    j.complete(claimed.id, "p1", {
      state: "succeeded",
      result: "verified",
      leaseToken: claimed.leaseToken,
    }).state,
    "succeeded",
  );
});

test("a previously leased waiting task needs a fresh claim before completion", (t) => {
  const { journal: j } = journal(t);
  j.enqueue({ project: "p1", key: "approval", objective: "Wait for approval" });
  const holder = j.claim("p1", { holder: "chat-a" });
  j.wait(holder.id, "p1", "approval required", holder.leaseToken);
  assert.throws(
    () => j.complete(holder.id, "p1", { state: "succeeded", result: "bypass" }),
    /AUTOPILOT_TASK_NOT_RUNNING/,
  );
  assert.throws(
    () =>
      j.complete(holder.id, "p1", {
        state: "succeeded",
        result: "stale",
        leaseToken: holder.leaseToken,
      }),
    /AUTOPILOT_TASK_NOT_RUNNING/,
  );
  j.resume(holder.id, "p1");
  const next = j.claim("p1", { holder: "chat-b" });
  assert.notEqual(next.leaseToken, holder.leaseToken);
  assert.equal(
    j.complete(holder.id, "p1", {
      state: "succeeded",
      result: "approved",
      leaseToken: next.leaseToken,
    }).state,
    "succeeded",
  );
});
