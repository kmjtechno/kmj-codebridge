// In-process acceptance for the ChatGPT -> CodeBridge -> worker -> CodeBridge
// -> ChatGPT loop using the REAL dispatcher, journal and mailbox on disk.
// It proves the contract and persistence; it does NOT prove live OAuth,
// gateway deployment or a real autonomous coding worker.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutopilotJournal } from "../src/autopilot.js";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";
import { buildContextResume } from "../src/context-resume.js";

const scope = { device: "d1", project: "p1" };
const CHATGPT = ["read", "write"];
const WORKER = ["read", "write"];

function boot(base) {
  const state = path.join(base, "state");
  fs.mkdirSync(state, { recursive: true });
  const runner = new JobRunner(path.join(state, "jobs"));
  const autopilot = new AutopilotJournal(path.join(state, "autopilot"));
  const root = path.join(base, "project");
  const other = path.join(base, "other");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: state,
      projects: [
        { id: "p1", root, writable: true, gates: {}, commands: {} },
        { id: "p2", root: other, writable: true, gates: {}, commands: {} },
      ],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
    autopilot,
  );
  return { dispatch, runner };
}

test("assign, acknowledge, result, offline persistence and resume packet", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-roundtrip-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  let session = boot(base);
  t.after(async () => session.runner.close());

  // 1. ChatGPT assigns a task and tells the worker through the mailbox.
  const task = await session.dispatch(
    "autopilot_enqueue",
    {
      ...scope,
      key: "fix-123",
      objective: "reproduce and fix bug 123",
      priority: 50,
      dependsOn: [],
    },
    CHATGPT,
  );
  const assign = await session.dispatch(
    "coordination_post",
    {
      ...scope,
      actor: "chatgpt",
      recipient: "worker-1",
      requestKey: "assign-fix-123",
      kind: "handoff",
      note: "task " + task.id + " is yours",
      replyTo: null,
      evidenceSha: null,
      reportedGate: "unknown",
    },
    CHATGPT,
  );
  assert.equal(assign.stored, true);

  // 2. Worker claims with a fencing token and acknowledges via reply.
  const claim = await session.dispatch(
    "autopilot_claim",
    { ...scope, holder: "worker-1" },
    WORKER,
  );
  assert.equal(claim.id, task.id);
  const ack = await session.dispatch(
    "coordination_post",
    {
      ...scope,
      actor: "worker-1",
      recipient: "chatgpt",
      requestKey: "ack-fix-123",
      kind: "result",
      note: "claimed " + task.id,
      replyTo: assign.id,
      evidenceSha: null,
      reportedGate: "unknown",
    },
    WORKER,
  );
  assert.equal(ack.stored, true);

  // 3. Worker finishes; completion needs its own lease token.
  await assert.rejects(
    session.dispatch(
      "autopilot_complete",
      { ...scope, task: task.id, state: "succeeded", result: "no token" },
      WORKER,
    ),
    /AUTOPILOT_LEASE_LOST/,
  );
  await session.dispatch(
    "autopilot_complete",
    {
      ...scope,
      task: task.id,
      state: "succeeded",
      result: "tests pass",
      leaseToken: claim.leaseToken,
    },
    WORKER,
  );
  const sha = "a".repeat(40);
  await session.dispatch(
    "coordination_post",
    {
      ...scope,
      actor: "worker-1",
      recipient: "chatgpt",
      requestKey: "done-fix-123",
      kind: "result",
      note: "fix-123 done",
      replyTo: ack.id,
      evidenceSha: sha,
      reportedGate: "pass",
    },
    WORKER,
  );

  // 4. "Offline" ChatGPT: restart everything, state must survive on disk.
  await session.runner.close();
  session = boot(base);
  const mailbox = await session.dispatch(
    "coordination_list",
    { ...scope, limit: 10, after: null },
    ["read"],
  );
  assert.equal(mailbox.totalStored, 3);
  assert.equal(mailbox.actorLabelsVerified, false);
  assert.deepEqual(mailbox.messages.map((m) => m.actor).sort(), [
    "chatgpt",
    "worker-1",
    "worker-1",
  ]);
  assert.ok(mailbox.messages.every((m) => m.project === "p1"));
  const done = mailbox.messages.find((m) => m.requestKey === "done-fix-123");
  assert.equal(done.replyTo, ack.id);
  assert.equal(done.evidenceSha, sha);

  // 5. Status and mailbox never leak the fencing token.
  const status = await session.dispatch(
    "autopilot_status",
    { ...scope, limit: 10 },
    ["read"],
  );
  assert.equal(status.tasks[0].state, "succeeded");
  assert.ok(!JSON.stringify([status, mailbox]).includes(claim.leaseToken));

  // 6. Project isolation: p2 sees nothing of p1's mailbox or tasks.
  const p2 = { device: "d1", project: "p2" };
  const p2Mail = await session.dispatch(
    "coordination_list",
    { ...p2, limit: 10, after: null },
    ["read"],
  );
  assert.equal(p2Mail.totalStored, 0);

  // 7. Resume packet built from the real results; claims stay unverified.
  const packet = buildContextResume({
    ...scope,
    autopilot: { ok: true, value: status },
    mailbox: { ok: true, value: mailbox },
  });
  assert.equal(packet.tasks.counts.succeeded, 1);
  assert.equal(packet.mailbox.totalStored, 3);
  assert.equal(packet.mailbox.actorLabelsVerified, false);
  assert.equal(packet.mailbox.recent.at(-1).evidenceSha, sha);
  assert.ok(packet.unknown.includes("git"));
  await session.runner.close();
});

test("write grant is required to post or assign", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-roundtrip-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { dispatch, runner } = boot(base);
  t.after(async () => runner.close());
  await assert.rejects(
    dispatch(
      "coordination_post",
      {
        ...scope,
        actor: "x",
        recipient: "all",
        requestKey: "k1",
        kind: "issue",
        note: "n",
        replyTo: null,
        evidenceSha: null,
        reportedGate: "unknown",
      },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch(
      "autopilot_enqueue",
      { ...scope, key: "k", objective: "o", priority: 0, dependsOn: [] },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
});
