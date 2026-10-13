import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutopilotJournal } from "../src/autopilot.js";

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-lease-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1000000;
  const now = () => clock;
  const journal = new AutopilotJournal(root, {
    now,
    leaseMs: 60000,
    maxAttempts: overrides.maxAttempts ?? 3,
  });
  return {
    root,
    journal,
    now,
    advance: (ms = 60001) => { clock += ms; },
  };
}

test("hasReady requeues the only expired running task instead of permanently idling", (t) => {
  const f = fixture(t);
  const task = f.journal.enqueue({
    project: "p1",
    key: "auto-repair:format:" + "a".repeat(40),
    objective: "Allowed deterministic repair",
  });
  const owned = f.journal.claim("p1", { holder: "worker" });
  f.journal.checkpoint(task.id, "p1", {
    summary: "FIX_MAY_HAVE_STARTED",
    next: "REVIEW_ON_RESTART",
    leaseToken: owned.leaseToken,
  });
  f.advance();
  const rawBefore = fs.readFileSync(path.join(f.root, "state.json"), "utf8");
  assert.equal(f.journal.status("p1").expiredRunningLeases, 1);
  assert.equal(
    fs.readFileSync(path.join(f.root, "state.json"), "utf8"),
    rawBefore,
    "read-only status must not mutate task leases",
  );
  assert.equal(
    f.journal.hasReady("p1", (candidate) => candidate.key === task.key),
    true,
  );
  const current = f.journal.get(task.id, "p1");
  assert.equal(current.state, "queued");
  assert.equal(current.recoveries, 1);
  assert.equal(current.checkpoint.next, "REVIEW_ON_RESTART");
  assert.equal(f.journal.status("p1").expiredRunningLeases, 0);
  assert.equal(f.journal.status("p1").counts.queued, 1);

  const restarted = new AutopilotJournal(f.root, {
    now: f.now,
    leaseMs: 60000,
  });
  assert.equal(restarted.get(task.id, "p1").state, "queued");
  const fresh = restarted.claim("p1", { holder: "different-worker" });
  assert.equal(fresh.attempts, 2);
  assert.equal(fresh.checkpoint.next, "REVIEW_ON_RESTART");
  assert.throws(
    () => restarted.checkpoint(task.id, "p1", {
      summary: "stale holder",
      next: "overwrite",
      leaseToken: owned.leaseToken,
    }),
    /AUTOPILOT_LEASE_LOST/,
  );
});

test("unexpired leases remain active and are not falsely reclaimed", (t) => {
  const f = fixture(t);
  const task = f.journal.enqueue({
    project: "p1",
    key: "active",
    objective: "Normal running task",
  });
  f.journal.claim("p1", { holder: "worker" });
  assert.equal(f.journal.hasReady("p1", () => true), false);
  assert.equal(f.journal.get(task.id, "p1").state, "running");
  assert.equal(f.journal.status("p1").expiredRunningLeases, 0);
});

test("expired and exhausted task fails closed and stops dependents", (t) => {
  const f = fixture(t, { maxAttempts: 1 });
  const task = f.journal.enqueue({
    project: "p1",
    key: "parent",
    objective: "Only one attempt allowed",
  });
  const dependent = f.journal.enqueue({
    project: "p1",
    key: "child",
    objective: "Must not execute after failed parent",
    dependsOn: [task.id],
  });
  f.journal.claim("p1", { holder: "worker" });
  f.advance();
  assert.equal(f.journal.hasReady("p1", () => true), false);
  assert.equal(f.journal.get(task.id, "p1").state, "failed");
  assert.equal(f.journal.get(dependent.id, "p1").state, "failed");
  assert.equal(f.journal.get(task.id, "p1").lastReason, "max_attempts_exceeded");
  assert.equal(f.journal.hasReady("p1", () => true), false);
  assert.equal(f.journal.get(task.id, "p1").recoveries, 1);
});

test("one project's expired lease cannot be reclaimed from another project", (t) => {
  const f = fixture(t);
  const first = f.journal.enqueue({
    project: "p1",
    key: "only-p1",
    objective: "one project",
  });
  f.journal.claim("p1", { holder: "worker" });
  f.advance();
  assert.equal(f.journal.hasReady("p2", () => true), false);
  assert.equal(f.journal.get(first.id, "p1").state, "running");
  assert.equal(f.journal.hasReady("p1", () => true), true);
  assert.equal(f.journal.get(first.id, "p1").state, "queued");
});
