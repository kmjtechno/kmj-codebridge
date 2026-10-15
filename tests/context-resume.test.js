import test from "node:test";
import assert from "node:assert/strict";
import { buildContextResume } from "../src/context-resume.js";
import { definitions } from "../src/tools.js";

const good = (value) => ({ ok: true, value });
const base = {
  device: "d1",
  project: "p1",
  now: new Date("2026-10-15T00:00:00Z"),
};

test("unreadable parts are UNKNOWN and listed, never guessed", () => {
  const p = buildContextResume({
    ...base,
    git: { ok: false, error: "DEVICE_TIMEOUT" },
  });
  assert.equal(p.git, "UNKNOWN");
  assert.equal(p.tasks, "UNKNOWN");
  assert.equal(p.mailbox, "UNKNOWN");
  assert.deepEqual(p.unknown, [
    "git",
    "tasks",
    "locks",
    "mailbox",
    "availableAuthorizedSlots",
  ]);
  assert.equal(p.evidence.git, false);
});

test("packet summarizes git, tasks, locks, mailbox and slots compactly", () => {
  const p = buildContextResume({
    ...base,
    git: good({ status: "## main...origin/main\n M src/a.js\n" }),
    autopilot: good({
      counts: { queued: 2, running: 1, succeeded: 3 },
      next: { id: "t-1" },
      tasks: [
        { id: "t-1", key: "k1", state: "queued", priority: 10 },
        { id: "t-2", key: "k2", state: "running", priority: 99 },
        { id: "t-3", key: "k3", state: "succeeded", priority: 100 },
      ],
    }),
    lanes: good({
      activeCount: 1,
      lanes: [
        {
          requestKey: "r1",
          paths: ["src/a.js"],
          expiresAt: "2026-10-15T01:00:00Z",
        },
      ],
    }),
    mailbox: good({
      totalStored: 9,
      messages: [
        {
          id: "m1",
          actor: "chatgpt",
          recipient: "all",
          kind: "handoff",
          evidenceSha: "abcdef1",
          reportedGate: "pass",
          note: "line1\nline2",
        },
      ],
    }),
    capacity: good({
      effectiveMaxConcurrent: 4,
      activeJobs: 1,
      blocked: false,
    }),
  });
  assert.deepEqual(p.git, { branch: "main...origin/main", dirty: true });
  assert.equal(p.tasks.counts.queued, 2);
  assert.deepEqual(
    p.tasks.topOpen.map((t) => t.id),
    ["t-2", "t-1"],
  );
  assert.equal(p.tasks.nextReadyTaskId, "t-1");
  assert.equal(p.locks.activeCount, 1);
  assert.equal(p.mailbox.recent[0].note, "line1 line2");
  assert.equal(p.mailbox.actorLabelsVerified, false);
  assert.equal(p.availableAuthorizedSlots, 3);
  assert.deepEqual(p.unknown, []);
});

test("size is bounded by dropping the oldest mailbox notes only", () => {
  const messages = Array.from({ length: 5 }, (_, i) => ({
    id: "m" + i,
    actor: "a",
    recipient: "all",
    kind: "note",
    note: "x".repeat(400),
    reportedGate: "unknown",
  }));
  const p = buildContextResume({
    ...base,
    git: good({ status: "## main\n" }),
    mailbox: good({ totalStored: 5, messages }),
  });
  assert.ok(JSON.stringify(p).length <= 6000);
  assert.ok(p.mailbox.recent.every((m) => m.note.length <= 160));
  assert.equal(p.version, 1);
  assert.ok(p.approxTokens > 0);
});

test("hostile ids, shas and control characters are sanitized", () => {
  const p = buildContextResume({
    ...base,
    mailbox: good({
      totalStored: 1,
      messages: [
        {
          id: "bad id!",
          actor: "../x",
          kind: "n\u0000ote",
          evidenceSha: "zzz",
          note: "a\u001b[31mb",
        },
      ],
    }),
  });
  const m = p.mailbox.recent[0];
  assert.equal(m.id, null);
  assert.equal(m.actor, null);
  assert.equal(m.evidenceSha, null);
  assert.ok(!/[\u0000-\u001f]/.test(m.note + m.kind));
});

test("context_resume is a read-scope catalog tool", () => {
  assert.equal(definitions.context_resume.access, "read");
});

import { contextDigest, unchangedResume } from "../src/context-resume.js";

test("digest ignores volatile fields and changes with real state", () => {
  const a = buildContextResume({
    ...base,
    git: good({ status: "## main\n" }),
  });
  const b = buildContextResume({
    ...base,
    now: new Date("2027-01-01T00:00:00Z"),
    git: good({ status: "## main\n" }),
  });
  const c = buildContextResume({
    ...base,
    git: good({ status: "## main\n M a\n" }),
  });
  assert.match(a.digest, /^[a-f0-9]{64}$/);
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.digest, c.digest);
  assert.equal(contextDigest(a), a.digest);
});

test("unchanged answer is tiny and carries only identity and digest", () => {
  const a = buildContextResume({
    ...base,
    git: good({ status: "## main\n" }),
  });
  const u = unchangedResume(a);
  assert.deepEqual(Object.keys(u).sort(), [
    "device",
    "digest",
    "kind",
    "project",
    "unchanged",
    "version",
  ]);
  assert.ok(JSON.stringify(u).length < JSON.stringify(a).length / 3);
});
