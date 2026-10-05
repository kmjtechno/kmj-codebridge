import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLedger } from "../src/audit.js";

function ledgerFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-audit-"));
  let sequence = 0;
  const ledger = new AuditLedger(dir, {
    now: () => "2026-10-05T12:30:00.000Z",
    id: () => `event-${String(++sequence).padStart(4, "0")}`,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, ledger };
}

test("audit ledger appends a verifiable SHA-256 chain", (t) => {
  const { ledger } = ledgerFixture(t);
  const attempt = ledger.append("p1", {
    device: "d1",
    tool: "write_file",
    access: "write",
    risk: "EDIT",
    phase: "attempt",
    outcome: "pending",
  });
  const result = ledger.append("p1", {
    device: "d1",
    tool: "write_file",
    access: "write",
    risk: "EDIT",
    phase: "result",
    outcome: "succeeded",
    correlationId: attempt.id,
  });

  assert.equal(attempt.sequence, 1);
  assert.equal(attempt.previousHash, "0".repeat(64));
  assert.match(attempt.hash, /^[a-f0-9]{64}$/);
  assert.equal(result.sequence, 2);
  assert.equal(result.previousHash, attempt.hash);
  assert.equal(result.correlationId, attempt.id);

  assert.deepEqual(ledger.status("p1"), {
    project: "p1",
    valid: true,
    events: 2,
    headHash: result.hash,
    lastSequence: 2,
  });
  const tail = ledger.tail("p1", 2);
  assert.equal(tail.valid, true);
  assert.equal(tail.entries.length, 2);
  assert.equal(tail.entries[1].hash, result.hash);
});

test("audit ledger rejects tampering and truncation", (t) => {
  const { dir, ledger } = ledgerFixture(t);
  ledger.append("p1", {
    device: "d1",
    tool: "write_file",
    access: "write",
    risk: "EDIT",
    phase: "attempt",
    outcome: "pending",
  });

  const file = path.join(dir, "p1.jsonl");
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original.replace('"pending"', '"failed"'));
  assert.throws(() => ledger.status("p1"), /AUDIT_LEDGER_INVALID/);

  fs.writeFileSync(file, original.trimEnd());
  assert.throws(() => ledger.status("p1"), /AUDIT_LEDGER_INVALID/);
});

test("audit ledger stores only bounded event metadata supplied by the dispatcher", (t) => {
  const { ledger } = ledgerFixture(t);
  const entry = ledger.append("p1", {
    device: "d1",
    tool: "run_quality_gate",
    access: "execute",
    risk: "TEST",
    phase: "result",
    outcome: "failed",
    correlationId: "attempt-0001",
    error: "GATE_FAILED",
    ignoredSecret: "supersecret",
  });

  assert.equal(entry.error, "GATE_FAILED");
  assert.equal(JSON.stringify(entry).includes("supersecret"), false);
  assert.deepEqual(Object.keys(entry), [
    "schema",
    "sequence",
    "id",
    "timestamp",
    "device",
    "project",
    "tool",
    "access",
    "risk",
    "phase",
    "outcome",
    "correlationId",
    "error",
    "previousHash",
    "hash",
  ]);
});
