import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AutopilotJournal } from "../src/autopilot.js";
import { waitForTaskChange } from "../src/autopilot-continuation.js";

function journal(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-continuation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new AutopilotJournal(dir);
}

test("journal wakes a subscribed worker after persistent enqueue", async (t) => {
  const j = journal(t);
  const controller = new AbortController();
  const started = Date.now();
  const waiting = waitForTaskChange(j, 10_000, controller.signal);
  j.enqueue({
    project: "project1",
    key: "continuation-first",
    objective: "Run an explicitly approved next step",
  });
  await waiting;
  assert.ok(Date.now() - started < 1000);
  assert.equal(j.status("project1").next.key, "continuation-first");
});

test("successful task releases only dependency-ready successor", async (t) => {
  const j = journal(t);
  const first = j.enqueue({
    project: "project1",
    key: "continuation-dependency-first",
    objective: "First",
  });
  j.enqueue({
    project: "project1",
    key: "continuation-dependency-second",
    objective: "Second",
    dependsOn: [first.id],
  });
  const claimed = j.claim("project1", { holder: "approved-worker" });
  assert.equal(claimed.id, first.id);
  assert.equal(j.status("project1").next, null);
  const waiting = waitForTaskChange(j, 10_000, new AbortController().signal);
  j.complete(first.id, "project1", {
    state: "succeeded",
    result: "verified externally",
    leaseToken: claimed.leaseToken,
  });
  await waiting;
  assert.equal(j.status("project1").next.key, "continuation-dependency-second");
});

test("abort cancels wake without mutating tasks", async (t) => {
  const j = journal(t);
  const controller = new AbortController();
  const wait = waitForTaskChange(j, 60_000, controller.signal);
  controller.abort();
  await wait;
  assert.equal(j.status("project1").counts.queued, 0);
});
