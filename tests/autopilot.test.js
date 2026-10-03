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
    objective: "token=" + "REAL_" + "SECRET continue safely",
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

test("rejected enqueue never prunes or mutates existing tasks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-autopilot-reject-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new AutopilotJournal(root, { maxTasks: 2 });
  for (const key of ["k1", "k2"]) {
    const task = journal.enqueue({ project: "p1", key, objective: "done" });
    journal.claim("p1");
    journal.complete(task.id, "p1", { state: "succeeded", result: "ok" });
  }
  const before = journal.state.tasks.length;
  assert.throws(
    () =>
      journal.enqueue({
        project: "p1",
        key: "bad",
        objective: "missing dependency",
        dependsOn: ["does-not-exist"],
      }),
    /AUTOPILOT_DEPENDENCY_NOT_FOUND/,
  );
  assert.equal(journal.state.tasks.length, before);
});

test("failed dependency cascades so the journal never deadlocks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-autopilot-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new AutopilotJournal(root, { maxTasks: 2 });
  const parent = journal.enqueue({
    project: "p1",
    key: "parent",
    objective: "fails",
  });
  const child = journal.enqueue({
    project: "p1",
    key: "child",
    objective: "depends on parent",
    dependsOn: [parent.id],
  });
  journal.claim("p1");
  journal.complete(parent.id, "p1", { state: "failed", result: "boom" });
  assert.equal(journal.get(child.id, "p1").state, "failed");
  assert.equal(journal.get(child.id, "p1").lastReason, "dependency_failed");
  for (let i = 0; i < 4; i++) {
    const filler = journal.enqueue({
      project: "p1",
      key: `filler${i}`,
      objective: "terminal filler",
    });
    journal.claim("p1");
    journal.complete(filler.id, "p1", { state: "succeeded", result: "ok" });
  }
  assert.ok(journal.state.tasks.length <= 2);
});

test("dependency failure cascades transitively", (t) => {
  const { journal } = fixture(t);
  const first = journal.enqueue({
    project: "p1",
    key: "first",
    objective: "root",
  });
  const second = journal.enqueue({
    project: "p1",
    key: "second",
    objective: "middle",
    dependsOn: [first.id],
  });
  const third = journal.enqueue({
    project: "p1",
    key: "third",
    objective: "leaf",
    dependsOn: [second.id],
  });
  journal.claim("p1");
  journal.complete(first.id, "p1", { state: "failed", result: "boom" });
  assert.equal(journal.get(second.id, "p1").state, "failed");
  assert.equal(journal.get(third.id, "p1").state, "failed");
});

test("successful dependency does not cascade failure", (t) => {
  const { journal } = fixture(t);
  const parent = journal.enqueue({
    project: "p1",
    key: "parent",
    objective: "succeeds",
  });
  const child = journal.enqueue({
    project: "p1",
    key: "child",
    objective: "waits for parent",
    dependsOn: [parent.id],
  });
  journal.claim("p1");
  journal.complete(parent.id, "p1", { state: "succeeded", result: "ok" });
  assert.equal(journal.get(child.id, "p1").state, "queued");
  assert.equal(journal.claim("p1").id, child.id);
});

test("restart retries are bounded so a poison task cannot loop forever", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-autopilot-poison-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let journal = new AutopilotJournal(root, { maxAttempts: 3 });
  const task = journal.enqueue({
    project: "p1",
    key: "poison",
    objective: "always crashes",
  });
  for (let i = 0; i < 3; i++) {
    journal.claim("p1");
    journal = new AutopilotJournal(root, { maxAttempts: 3 });
  }
  const exhausted = journal.get(task.id, "p1");
  assert.equal(exhausted.state, "failed");
  assert.equal(exhausted.lastReason, "max_attempts_exceeded");
  assert.match(exhausted.result, /3 attempts/);
});

test("exhausted task cascades failure to its dependents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-autopilot-exhaust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let journal = new AutopilotJournal(root, { maxAttempts: 1 });
  const parent = journal.enqueue({
    project: "p1",
    key: "parent",
    objective: "poison",
  });
  const child = journal.enqueue({
    project: "p1",
    key: "child",
    objective: "depends on poison",
    dependsOn: [parent.id],
  });
  journal.claim("p1");
  journal = new AutopilotJournal(root, { maxAttempts: 1 });
  assert.equal(journal.get(parent.id, "p1").state, "failed");
  assert.equal(journal.get(child.id, "p1").state, "failed");
});
