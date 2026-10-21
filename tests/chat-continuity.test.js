import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatContinuity } from "../src/chat-continuity.js";
import { createDispatcher, definitions } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";
import { createSymlinkOrSkip } from "./support/symlink-fixture.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-multichat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  const store = new ChatContinuity(state);
  return { root, state, store };
}

test("multiple project chats are durable, independently scoped, revision-fenced", (t) => {
  const { state, store } = fixture(t);
  const empty = store.status("p1", "chat1");
  assert.equal(empty.exists, false);
  assert.equal(empty.revision, null);
  const saved = store.save("p1", "chat1", {
    requestKey: "checkpoint1",
    expectedRevision: null,
    summary: "Reviewed codebridge sync architecture",
    next: "Run preflight and verify CI",
    blockers: ["Production activation pending"],
  });
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.equal(store.status("p2", "chat1").exists, false);
  assert.equal(store.status("p1", "chat2").exists, false);
  const restored = new ChatContinuity(state).status("p1", "chat1");
  assert.equal(restored.revision, saved.revision);
  assert.equal(restored.summary, "Reviewed codebridge sync architecture");
  assert.equal(restored.contentTrusted, false);
  assert.equal(restored.chatAutoWake, false);
  assert.throws(
    () =>
      store.save("p1", "chat1", {
        requestKey: "checkpoint2",
        expectedRevision: null,
        summary: "Unsafe stale overwrite",
        next: "Nothing",
        blockers: [],
      }),
    /CHAT_CONTINUITY_VERSION_CONFLICT/,
  );
  const replay = store.save("p1", "chat1", {
    requestKey: "checkpoint1",
    expectedRevision: null,
    summary: "Reviewed codebridge sync architecture",
    next: "Run preflight and verify CI",
    blockers: ["Production activation pending"],
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.revision, saved.revision);
  const next = store.save("p1", "chat1", {
    requestKey: "checkpoint2",
    expectedRevision: saved.revision,
    summary: "CI passed on exact head",
    next: "Review guardrails",
    blockers: [],
  });
  assert.notEqual(next.revision, saved.revision);
  assert.equal(new ChatContinuity(state).status("p1", "chat1").sequence, 2);
});

test("secret-like notes, paths, invalid scopes and conflicting idempotency fail closed", (t) => {
  const { store } = fixture(t);
  for (const summary of [
    "https://private.example/token",
    "-".repeat(5) + "BEGIN SOMETHING",
    "text\nMULTILINE",
    "sk-" + "a".repeat(30),
    "a".repeat(1001),
  ]) {
    assert.throws(
      () =>
        store.save("p1", "chat1", {
          requestKey: "private1",
          expectedRevision: null,
          summary,
          next: "Keep scoped",
          blockers: [],
        }),
      /CHAT_CONTINUITY_UNSAFE_TEXT/,
    );
  }
  assert.throws(() => store.status("../escape", "x"), /INVALID_SCOPE/);
  assert.throws(() => store.status("p1", "../../escape"), /INVALID_SCOPE/);
  const original = {
    requestKey: "safe1",
    expectedRevision: null,
    summary: "Scoped project progress",
    next: "Run approved tests",
    blockers: [],
  };
  store.save("p1", "chat1", original);
  assert.throws(
    () =>
      store.save("p1", "chat1", {
        ...original,
        summary: "Changed payload under duplicate request key",
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(store.status("p1", "chat1").summary, original.summary);
});

test("corrupt stored checkpoint is rejected, not silently overwritten", (t) => {
  const { store } = fixture(t);
  store.save("p1", "chat1", {
    requestKey: "save1",
    expectedRevision: null,
    summary: "Verified progress",
    next: "Continue",
    blockers: [],
  });
  const file = store.file("p1", "chat1");
  fs.writeFileSync(file, "{");
  assert.throws(() => store.status("p1", "chat1"), /CHAT_CONTINUITY_CORRUPT/);
});

test("symlinked stored checkpoint is rejected when symlink fixtures are permitted", (t) => {
  const { root, store } = fixture(t);
  store.save("p1", "chat1", {
    requestKey: "save1",
    expectedRevision: null,
    summary: "Verified progress",
    next: "Continue",
    blockers: [],
  });
  const file = store.file("p1", "chat1");
  fs.rmSync(file);
  const elsewhere = path.join(root, "elsewhere");
  fs.writeFileSync(elsewhere, "{}");
  if (!createSymlinkOrSkip(t, elsewhere, file)) return;
  assert.throws(() => store.status("p1", "chat1"), /CHAT_CONTINUITY_CORRUPT/);
});

test("actual dispatch enforces read/write grants and independent project state", async (t) => {
  const { root, state } = fixture(t);
  const p1 = path.join(root, "one");
  const p2 = path.join(root, "two");
  fs.mkdirSync(p1);
  fs.mkdirSync(p2);
  const runner = new JobRunner(path.join(state, "jobs"));
  t.after(async () => runner.close());
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: state,
      projects: [
        { id: "p1", root: p1, writable: true, gates: {}, commands: {} },
        { id: "p2", root: p2, writable: true, gates: {}, commands: {} },
      ],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  const scope = { device: "d1", project: "p1", lane: "chat-one" };
  const input = {
    ...scope,
    requestKey: "task-1",
    expectedRevision: null,
    summary: "Project scoped task snapshot",
    next: "Run CodeBridge read-only tests",
    blockers: [],
  };
  await assert.rejects(
    dispatch("chat_continuity_save", input, ["read"]),
    /ACCESS_DENIED/,
  );
  const saved = await dispatch("chat_continuity_save", input, ["write"]);
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  const visible = await dispatch("chat_continuity_read", scope, ["read"]);
  assert.equal(visible.summary, input.summary);
  const hidden = await dispatch(
    "chat_continuity_read",
    { ...scope, project: "p2" },
    ["read"],
  );
  assert.equal(hidden.exists, false);
  await assert.rejects(
    dispatch("chat_continuity_read", { ...scope, device: "other" }, ["read"]),
    /ACCESS_DENIED/,
  );
  assert.equal(definitions.chat_continuity_read.access, "read");
  assert.equal(definitions.chat_continuity_save.access, "write");
  assert.equal(definitions.multi_chat_sync.access, "read");
});
