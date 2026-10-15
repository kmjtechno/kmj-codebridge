import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentCoordination } from "../src/agent-coordination.js";
import { createDispatcher, definitions } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";

const now = 1800000000000;
const sample = (overrides = {}) => ({
  actor: "chatgpt",
  recipient: "claude",
  requestKey: "issue-1",
  kind: "issue",
  note: "Check isolated CI evidence for PR424",
  ...overrides,
});

test("project-scoped messages support idempotent replies and cursor paging", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-collab-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const box = new AgentCoordination(dir, { now: () => now });
  const a = box.post("project1", sample());
  assert.equal(a.stored, true);
  assert.equal(a.reused, false);
  assert.equal(box.post("project1", sample()).reused, true);
  const b = box.post(
    "project1",
    sample({
      actor: "claude",
      recipient: "chatgpt",
      requestKey: "reply-1",
      kind: "analysis",
      note: "PR424 exact-head CI shows five successful jobs",
      replyTo: a.id,
      reportedGate: "pass",
      evidenceSha: "a".repeat(40),
    }),
  );
  assert.equal(b.reused, false);
  const first = box.list("project1", { limit: 1 });
  assert.equal(first.messages.length, 1);
  assert.ok(first.nextCursor);
  const second = box.list("project1", { after: first.nextCursor, limit: 5 });
  assert.equal(second.messages.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(box.list("other").messages.length, 0);
  assert.equal(JSON.stringify(first).includes("leaseToken"), false);
  assert.equal(first.actorLabelsVerified, false);
  assert.equal(first.automaticWorkerStarted, false);
});

test("retries cannot mutate messages, cross-project replies are denied", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-collab-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const box = new AgentCoordination(dir);
  const a = box.post("project1", sample());
  assert.throws(
    () => box.post("project1", sample({ note: "Conflicting update" })),
    /COORDINATION_IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () => box.post("other", sample({ replyTo: a.id })),
    /COORDINATION_REPLY_NOT_FOUND/,
  );
  assert.throws(
    () => box.list("project1", { after: "f".repeat(64) }),
    /COORDINATION_CURSOR_UNKNOWN/,
  );
});

test("secrets, URLs, binary/control text and damaged journals fail closed", (t) => {
  const dir = fs.mkdtempSync(joinTmp());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const box = new AgentCoordination(dir);
  for (const note of [
    ["Bear", "er ", "abcdefghijklmnopqrstuvwxyz"].join(""),
    "https://example.com/private",
    "token=topsecretvalue",
    "line one\nline two",
  ]) {
    assert.throws(
      () => box.post("project1", sample({ note })),
      /COORDINATION_SENSITIVE_OR_INVALID_NOTE/,
    );
  }
  const a = box.post("project1", sample());
  fs.writeFileSync(
    path.join(dir, "agent-coordination", "project1", a.id + ".json"),
    "{broken",
  );
  assert.throws(() => box.list("project1"), /COORDINATION_JOURNAL_CORRUPT/);
});

function joinTmp() {
  return path.join(os.tmpdir(), "cb-collab-");
}

test("MCP dispatcher isolates messages by project and enforces write grants", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-collab-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const runner = new JobRunner(path.join(dir, "jobs"));
  t.after(async () => runner.close());
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir: path.join(dir, "state"),
      projects: [
        { id: "project1", root, writable: true, gates: {}, commands: {} },
      ],
    },
    runner,
    () => ({
      features: ["read", "write"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  const scope = { device: "device1", project: "project1" };
  const request = { ...scope, ...sample() };
  assert.ok(definitions.coordination_post);
  assert.ok(definitions.coordination_list);
  await assert.rejects(
    dispatch("coordination_post", request, ["read"]),
    /ACCESS_DENIED/,
  );
  const posted = await dispatch("coordination_post", request, ["write"]);
  assert.ok(posted.id);
  const list = await dispatch("coordination_list", scope, ["read"]);
  assert.equal(list.messages.length, 1);
  assert.equal(list.messages[0].note, request.note);
  await assert.rejects(
    dispatch("coordination_list", { ...scope, project: "other" }, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
});
