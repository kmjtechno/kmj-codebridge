import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRunner } from "../src/jobs.js";

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("valid journal loads and interrupted jobs are recovered", (t) => {
  const root = directory(t);
  fs.writeFileSync(
    path.join(root, "valid-id.json"),
    JSON.stringify({
      id: "valid-id",
      project: "p1",
      state: "running",
      startedAt: "2026-10-06T10:00:00Z",
      endedAt: null,
    }),
  );
  const runner = new JobRunner(root);
  assert.equal(runner.get("valid-id", "p1").state, "interrupted");
  assert.equal(runner.list("p1").total, 1);
  assert.equal(runner.list("p2").total, 0);
});

test("journal filename and embedded ID must match", (t) => {
  const root = directory(t);
  fs.writeFileSync(
    path.join(root, "one.json"),
    JSON.stringify({ id: "two", project: "p1", state: "succeeded" }),
  );
  assert.throws(() => new JobRunner(root), /CORRUPT_JOURNAL/);
});

test("malformed JSON fails closed with a stable error", (t) => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, "broken.json"), "{");
  assert.throws(() => new JobRunner(root), /CORRUPT_JOURNAL/);
});

test("oversized journals are rejected before parsing", (t) => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, "oversized.json"), " ".repeat(131073));
  assert.throws(() => new JobRunner(root), /CORRUPT_JOURNAL/);
});

test("symlinked and hardlinked journals are rejected", (t) => {
  const root = directory(t);
  const outside = path.join(root, "target.txt");
  fs.writeFileSync(
    outside,
    JSON.stringify({ id: "linked", project: "p1", state: "succeeded" }),
  );
  fs.symlinkSync(outside, path.join(root, "linked.json"));
  assert.throws(() => new JobRunner(root), /CORRUPT_JOURNAL/);
  fs.unlinkSync(path.join(root, "linked.json"));
  fs.linkSync(outside, path.join(root, "linked.json"));
  assert.throws(() => new JobRunner(root), /CORRUPT_JOURNAL/);
});
