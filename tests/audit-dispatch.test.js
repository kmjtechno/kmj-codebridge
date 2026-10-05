import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLedger } from "../src/audit.js";
import { createDispatcher } from "../src/tools.js";

test("write and execute dispatches create secret-free audit attempt/result pairs", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-audit-dispatch-"));
  const root = path.join(base, "project");
  const state = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  let eventId = 0;
  const audit = new AuditLedger(path.join(state, "audit"), {
    now: () => "2026-10-05T12:31:00.000Z",
    id: () => `audit-${String(++eventId).padStart(4, "0")}`,
  });
  const runner = { maxConcurrent: 1 };
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: state,
      projects: [{ id: "p1", root, writable: true, gates: {}, commands: {} }],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
    null,
    null,
    audit,
  );

  const secretContent = "hello\ntoken=supersecret\n";
  await dispatch(
    "write_file",
    {
      device: "d1",
      project: "p1",
      path: "hello.txt",
      content: secretContent,
      expectedHash: null,
    },
    ["write"],
  );

  await assert.rejects(
    dispatch(
      "write_file",
      {
        device: "d1",
        project: "p1",
        path: "hello.txt",
        content: "changed",
        expectedHash: "0".repeat(64),
      },
      ["write"],
    ),
    /CONTENT_CONFLICT/,
  );

  const tail = await dispatch(
    "audit_tail",
    { device: "d1", project: "p1", limit: 10 },
    ["read"],
  );
  assert.equal(tail.valid, true);
  assert.equal(tail.events, 4);
  assert.deepEqual(
    tail.entries.map((entry) => [
      entry.tool,
      entry.risk,
      entry.phase,
      entry.outcome,
      entry.error,
    ]),
    [
      ["write_file", "EDIT", "attempt", "pending", null],
      ["write_file", "EDIT", "result", "succeeded", null],
      ["write_file", "EDIT", "attempt", "pending", null],
      ["write_file", "EDIT", "result", "failed", "CONTENT_CONFLICT"],
    ],
  );
  assert.equal(JSON.stringify(tail).includes("supersecret"), false);
  assert.equal(JSON.stringify(tail).includes("hello.txt"), false);
  assert.equal(JSON.stringify(tail).includes("changed"), false);

  const status = await dispatch(
    "audit_status",
    { device: "d1", project: "p1" },
    ["read"],
  );
  assert.equal(status.valid, true);
  assert.equal(status.events, 4);
  assert.equal(status.lastSequence, 4);
});
