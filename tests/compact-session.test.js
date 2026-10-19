import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CompactSessionStore } from "../src/compact-session.js";
import { createDispatcher, definitions } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-compact-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, "state");
  fs.mkdirSync(state);
  return { dir, state, store: new CompactSessionStore(state) };
}
function draft(overrides = {}) {
  return {
    objective: "Finish CodeBridge with zero added spend",
    summary: "Source PR 569 is draft; P720 checkout has dirty files",
    decisions: ["Moli pinned fast lane remains public-only"],
    constraints: ["Do not overwrite dirty checkout", "Require exact head CI"],
    evidence: ["PR 569 head SHA abcdef1 is caller reported"],
    blockers: ["Authenticated browser not deployed"],
    nextSteps: ["Review exact CI before merge", "Validate runtime tools"],
    ...overrides,
  };
}
test("save and resume a bounded project-scoped checkpoint with portable handoff", (t) => {
  const { state, store } = fixture(t);
  const saved = store.save("kmj-codebridge", "chat-main", {
    requestKey: "compact-1",
    expectedRevision: null,
    ...draft(),
  });
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.equal(saved.reused, false);
  const result = new CompactSessionStore(state).resume("kmj-codebridge", "chat-main");
  assert.equal(result.exists, true);
  assert.equal(result.contentTrusted, false);
  assert.equal(result.hostContextWindowExtended, false);
  assert.equal(result.chatAutoWake, false);
  assert.match(result.handoff, /Must-preserve constraints:/);
  assert.match(result.handoff, /Do not overwrite dirty checkout/);
  assert.match(result.handoff, /CLIENT_REPORTED_UNVERIFIED/);
  assert.ok(result.approxHandoffTokens > 0);
  assert.equal(store.resume("other-project", "chat-main").exists, false);
  assert.equal(store.resume("kmj-codebridge", "other-lane").exists, false);
  assert.deepEqual(store.resume("kmj-codebridge", "chat-main", saved.revision), {
    version: 1,
    project: "kmj-codebridge",
    lane: "chat-main",
    unchanged: true,
    revision: saved.revision,
  });
});
test("CAS, retry idempotency and cross-lane isolation protect concurrent chats", (t) => {
  const { store } = fixture(t);
  const one = store.save("p1", "lane1", {
    requestKey: "one",
    expectedRevision: null,
    ...draft(),
  });
  assert.equal(
    store.save("p1", "lane1", { requestKey: "one", expectedRevision: null, ...draft() }).reused,
    true,
  );
  assert.throws(
    () => store.save("p1", "lane1", { requestKey: "two", expectedRevision: null, ...draft() }),
    /COMPACT_SESSION_VERSION_CONFLICT/,
  );
  assert.throws(
    () => store.save("p1", "lane1", { requestKey: "one", expectedRevision: null, ...draft({ summary: "changed" }) }),
    /COMPACT_SESSION_IDEMPOTENCY_CONFLICT/,
  );
  const two = store.save("p1", "lane1", {
    requestKey: "two",
    expectedRevision: one.revision,
    ...draft({ summary: "Second compact checkpoint" }),
  });
  assert.notEqual(one.revision, two.revision);
  assert.equal(store.resume("p1", "lane1").sequence, 2);
  store.save("p1", "lane2", {
    requestKey: "lane2-one",
    expectedRevision: null,
    ...draft(),
  });
  assert.equal(store.resume("p1", "lane1").summary, "Second compact checkpoint");
});
test("never store secrets, URLs, transcript dumps or oversized silent truncations", (t) => {
  const { store } = fixture(t);
  for (const bad of [
    "https://example.com/secret",
    "-----BEGIN PRIVATE KEY-----",
    "token=something",
    "user@example.com",
    "line1\nline2",
    "x".repeat(1801),
  ]) {
    assert.throws(
      () => store.save("p1", "lane1", {
        requestKey: "bad-1",
        expectedRevision: null,
        ...draft({ summary: bad }),
      }),
      /COMPACT_SESSION_UNSAFE_TEXT/,
    );
  }
  assert.throws(
    () => store.save("p1", "lane1", {
      requestKey: "bad-next",
      expectedRevision: null,
      ...draft({ nextSteps: [] }),
    }),
    /COMPACT_SESSION_INVALID_DRAFT/,
  );
  assert.throws(() => store.resume("p1", "../../unsafe"), /COMPACT_SESSION_INVALID_SCOPE/);
});
test("corrupted checkpoints cannot be read or overwritten", (t) => {
  const { store } = fixture(t);
  const first = store.save("p1", "lane1", {
    requestKey: "one",
    expectedRevision: null,
    ...draft(),
  });
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  fs.writeFileSync(store.file("p1", "lane1"), "{}");
  assert.throws(() => store.resume("p1", "lane1"), /COMPACT_SESSION_CORRUPT/);
  assert.throws(
    () => store.save("p1", "lane1", { requestKey: "two", expectedRevision: first.revision, ...draft() }),
    /COMPACT_SESSION_CORRUPT/,
  );
});
test("MCP permissions and exact project scope govern save and resume", async (t) => {
  const { dir, state } = fixture(t);
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  const runner = new JobRunner(path.join(state, "jobs"));
  t.after(async () => runner.close());
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: state,
      projects: [
        { id: "p1", root, writable: true, gates: {}, commands: {} },
        { id: "readonly", root, writable: false, gates: {}, commands: {} },
      ],
    },
    runner,
    () => ({ features: ["read", "write", "execute"], limits: { concurrent_jobs: 1 } }),
  );
  const input = {
    device: "d1",
    project: "p1",
    lane: "chat1",
    requestKey: "first",
    expectedRevision: null,
    ...draft(),
  };
  await assert.rejects(dispatch("compact_session_save", input, ["read"]), /ACCESS_DENIED/);
  await assert.rejects(
    dispatch("compact_session_save", { ...input, project: "readonly" }, ["write"]),
    /READ_ONLY_PROJECT/,
  );
  const saved = await dispatch("compact_session_save", input, ["write"]);
  assert.equal(saved.checkpointSaved, true);
  assert.equal(saved.hostContextWindowExtended, false);
  const read = await dispatch(
    "compact_session_resume",
    { device: "d1", project: "p1", lane: "chat1" },
    ["read"],
  );
  assert.equal(read.summary, input.summary);
  assert.match(read.handoff, /Next actions/);
  await assert.rejects(
    dispatch("compact_session_resume", { device: "other", project: "p1", lane: "chat1" }, ["read"]),
    /ACCESS_DENIED/,
  );
  assert.equal(definitions.compact_session_save.access, "write");
  assert.equal(definitions.compact_session_resume.access, "read");
});
