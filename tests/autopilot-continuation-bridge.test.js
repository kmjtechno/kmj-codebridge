import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AutopilotJournal } from "../src/autopilot.js";
import { AgentCoordination } from "../src/agent-coordination.js";
import {
  continuationReceipts,
  startAutopilotContinuationBridge,
} from "../src/autopilot-continuation-bridge.js";

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    journal: new AutopilotJournal(path.join(dir, "autopilot")),
    coordination: new AgentCoordination(dir),
  };
}

async function wake() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("new approved queue item is durably published to the correct project mailbox", async (t) => {
  const { dir, journal, coordination } = setup(t);
  const bridge = startAutopilotContinuationBridge({
    journal,
    stateDir: dir,
    projects: ["p1", "p2"],
  });
  t.after(() => bridge.close());
  const task = journal.enqueue({
    project: "p1",
    key: "start",
    objective: "A private customer objective must not enter the mailbox",
  });
  await wake();
  const messages = coordination.list("p1").messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].actor, "codebridge-autopilot");
  assert.equal(messages[0].kind, "handoff");
  assert.equal(messages[0].requestKey, "next-" + task.id);
  assert.equal(messages[0].recipient, "all");
  assert.equal(coordination.list("p2").totalStored, 0);
  assert.doesNotMatch(
    JSON.stringify(messages),
    /private customer|leaseToken|secret/i,
  );
  assert.equal(bridge.status("p1").automaticChatWake, false);
  assert.equal(bridge.status("p1").backgroundInference, false);
});

test("success releases the next dependency-ready task and records both outcomes", async (t) => {
  const { dir, journal, coordination } = setup(t);
  const bridge = startAutopilotContinuationBridge({
    journal,
    stateDir: dir,
    projects: ["p1"],
  });
  t.after(() => bridge.close());
  const a = journal.enqueue({
    project: "p1",
    key: "first",
    objective: "Run an approved gate",
  });
  const second = journal.enqueue({
    project: "p1",
    key: "second",
    objective: "Run an approved followup",
    dependsOn: [a.id],
  });
  await wake();
  const claimed = journal.claim("p1", { holder: "agent-test" });
  assert.equal(claimed.id, a.id);
  journal.complete(claimed.id, "p1", {
    state: "succeeded",
    result: "VERIFIED_BY_QUALITY_GATE",
    leaseToken: claimed.leaseToken,
  });
  await wake();
  const rows = coordination.list("p1").messages;
  assert.ok(rows.some((row) => row.requestKey === "done-" + a.id));
  assert.ok(rows.some((row) => row.requestKey === "next-" + second.id));
  assert.ok(rows.every((row) => row.reportedGate === "unknown"));
  assert.equal(journal.status("p1").next.id, second.id);
  assert.ok(bridge.status("p1").deliveredThisProcess >= 3);
});

test("waiting on one task does not block an independent queued task", async (t) => {
  const { dir, journal, coordination } = setup(t);
  const bridge = startAutopilotContinuationBridge({
    journal,
    stateDir: dir,
    projects: ["p1"],
  });
  t.after(() => bridge.close());
  const first = journal.enqueue({
    project: "p1",
    key: "blocked",
    objective: "Wait for approved CI review",
    priority: 10,
  });
  const independent = journal.enqueue({
    project: "p1",
    key: "independent",
    objective: "Unrelated authorized next step",
    priority: 1,
  });
  await wake();
  const claimed = journal.claim("p1", { holder: "agent-test" });
  assert.equal(claimed.id, first.id);
  journal.wait(claimed.id, "p1", "Owner approval required", claimed.leaseToken);
  await wake();
  const rows = coordination.list("p1").messages;
  assert.ok(rows.some((row) => row.requestKey === "blocked-" + first.id));
  assert.ok(rows.some((row) => row.requestKey === "next-" + independent.id));
  assert.equal(journal.status("p1").next.id, independent.id);
  assert.ok(rows.every((row) => !row.note.includes("Owner approval required")));
});

test("crash-restart reconcile is idempotent, closes cleanly and never runs commands", async (t) => {
  const { dir, journal, coordination } = setup(t);
  const item = journal.enqueue({
    project: "p1",
    key: "recovery",
    objective: "A legitimate approved task",
  });
  const a = startAutopilotContinuationBridge({
    journal,
    stateDir: dir,
    projects: ["p1"],
  });
  await wake();
  a.close();
  const b = startAutopilotContinuationBridge({
    journal,
    stateDir: dir,
    projects: ["p1"],
  });
  await wake();
  assert.equal(coordination.list("p1").totalStored, 1);
  assert.equal(
    coordination.list("p1").messages[0].requestKey,
    "next-" + item.id,
  );
  b.close();
  journal.enqueue({
    project: "p1",
    key: "later",
    objective: "More approved work",
  });
  await wake();
  assert.equal(coordination.list("p1").totalStored, 1);
  assert.equal(b.status("p1").installed, false);
});

test("missing or full coordination mailbox never destroys completed journal state", async (t) => {
  const { journal } = setup(t);
  const posts = [];
  const bridge = startAutopilotContinuationBridge({
    journal,
    stateDir: "unused",
    projects: ["p1"],
    coordination: {
      post(_project, data) {
        posts.push(data);
        const error = new Error("COORDINATION_CAPACITY_REACHED");
        error.code = "COORDINATION_CAPACITY_REACHED";
        throw error;
      },
    },
  });
  t.after(() => bridge.close());
  journal.enqueue({
    project: "p1",
    key: "bounded",
    objective: "Approved bounded work",
  });
  await wake();
  assert.equal(posts.length, 1);
  assert.equal(journal.status("p1").counts.queued, 1);
  assert.equal(bridge.status("p1").lastError, "COORDINATION_CAPACITY_REACHED");
});

test("failed mailbox write retries only after bounded cooldown", async (t) => {
  const { journal } = setup(t);
  let clock = 1_000;
  let attempts = 0;
  const bridge = startAutopilotContinuationBridge({
    journal,
    stateDir: "unused",
    projects: ["p1"],
    now: () => clock,
    coordination: {
      post() {
        attempts++;
        const error = new Error("COORDINATION_CAPACITY_REACHED");
        error.code = "COORDINATION_CAPACITY_REACHED";
        throw error;
      },
    },
  });
  t.after(() => bridge.close());
  journal.enqueue({ project: "p1", key: "first", objective: "One", priority: 5 });
  await wake();
  assert.equal(attempts, 1);
  journal.enqueue({ project: "p1", key: "second", objective: "Two", priority: 0 });
  await wake();
  assert.equal(attempts, 1);
  clock += 60_001;
  journal.enqueue({ project: "p1", key: "third", objective: "Three", priority: -5 });
  await wake();
  assert.equal(attempts, 2);
  assert.equal(bridge.status("p1").lastError, "COORDINATION_CAPACITY_REACHED");
});

test("receipts never include objectives, checkpoints or arbitrary shell actions", (t) => {
  const { journal } = setup(t);
  const task = journal.enqueue({
    project: "p1",
    key: "safe",
    objective: "A sensitive task objective",
  });
  const items = continuationReceipts(journal, "p1");
  assert.deepEqual(
    items.map((item) => item.key),
    ["next-" + task.id],
  );
  assert.doesNotMatch(
    JSON.stringify(items),
    /sensitive task objective|shell|execute arbitrary/,
  );
});
