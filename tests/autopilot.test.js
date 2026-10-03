import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutopilotJournal } from "../src/autopilot.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-autopilot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, journal: new AutopilotJournal(root) };
}

test("claims highest-priority dependency-ready task", (t) => {
  const { journal } = fixture(t);
  const first = journal.enqueue({
    project: "p1",
    key: "foundation",
    objective: "finish foundation",
    priority: 1,
  });
  journal.enqueue({
    project: "p1",
    key: "blocked-high",
    objective: "depends on foundation",
    priority: 100,
    dependsOn: [first.id],
  });
  const independent = journal.enqueue({
    project: "p1",
    key: "independent",
    objective: "safe independent work",
    priority: 10,
  });
  assert.equal(journal.claim("p1").id, independent.id);
});

test("waiting task does not block independent queued work", (t) => {
  const { journal } = fixture(t);
  const blocked = journal.enqueue({
    project: "p1",
    key: "blocked",
    objective: "needs owner action",
    priority: 20,
  });
  journal.enqueue({
    project: "p1",
    key: "ready",
    objective: "continue independently",
    priority: 10,
  });
  assert.equal(journal.claim("p1").id, blocked.id);
  journal.wait(blocked.id, "p1", "owner approval required");
  assert.equal(journal.claim("p1").key, "ready");
});

test("restart requeues running task and preserves checkpoint", (t) => {
  const { root, journal } = fixture(t);
  const task = journal.enqueue({
    project: "p1",
    key: "resume",
    objective: "long autonomous task",
  });
  journal.claim("p1");
  journal.checkpoint(task.id, "p1", {
    summary: "phase one complete",
    next: "continue phase two",
  });

  const reloaded = new AutopilotJournal(root);
  const status = reloaded.status("p1");
  const recovered = status.tasks.find((candidate) => candidate.id === task.id);
  assert.equal(recovered.state, "queued");
  assert.equal(recovered.recoveries, 1);
  assert.equal(recovered.checkpoint.next, "continue phase two");
  assert.equal(recovered.lastReason, "agent_restart");
});

test("idempotency key never creates duplicate work", (t) => {
  const { journal } = fixture(t);
  const input = {
    project: "p1",
    key: "same",
    objective: "one task only",
    priority: 2,
  };
  const first = journal.enqueue(input);
  const second = journal.enqueue(input);
  assert.equal(second.id, first.id);
  assert.throws(
    () => journal.enqueue({ ...input, objective: "different objective" }),
    /AUTOPILOT_IDEMPOTENCY_CONFLICT/,
  );
});

test("dependency becomes runnable only after success", (t) => {
  const { journal } = fixture(t);
  const parent = journal.enqueue({
    project: "p1",
    key: "parent",
    objective: "parent task",
    priority: 1,
  });
  const child = journal.enqueue({
    project: "p1",
    key: "child",
    objective: "child task",
    priority: 100,
    dependsOn: [parent.id],
  });
  assert.equal(journal.claim("p1").id, parent.id);
  journal.complete(parent.id, "p1", { state: "succeeded", result: "done" });
  assert.equal(journal.claim("p1").id, child.id);
});

test("persisted task text is redacted", (t) => {
  const { journal } = fixture(t);
  const task = journal.enqueue({
    project: "p1",
    key: "redact",
    objective: "token=[REDACTED] continue safely",
  });
  assert.doesNotMatch(task.objective, /REAL_SECRET/);
  assert.match(task.objective, /\[REDACTED\]/);
});

test("bounded retention prunes only unreferenced terminal history", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-autopilot-prune-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new AutopilotJournal(root, { maxTasks: 2 });

  const old = journal.enqueue({
    project: "p1",
    key: "old",
    objective: "old completed work",
  });
  journal.claim("p1");
  journal.complete(old.id, "p1", { state: "succeeded", result: "done" });

  journal.enqueue({
    project: "p1",
    key: "current",
    objective: "current work",
  });
  journal.enqueue({
    project: "p1",
    key: "next",
    objective: "next work",
  });

  const status = journal.status("p1", 10);
  assert.equal(status.tasks.length, 2);
  assert.ok(status.tasks.every((task) => task.id !== old.id));
});

