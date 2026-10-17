import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { compactReadBatchResult } from "../src/compact-read-results.js";

const sha = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

test("compacts a large result without disclosing private text or changing its SHA", () => {
  const value = {
    status: "READY",
    running: 3,
    project: "secret-project",
    content: "VERY_PRIVATE_SOURCE_DATA".repeat(5000),
    token: "DO_NOT_LEAK_THIS_TOKEN",
    nested: { credentials: "DO_NOT_LEAK" },
  };
  const actual = compactReadBatchResult({
    key: "one",
    tool: "project_snapshot",
    ok: true,
    value,
  });
  assert.equal(actual.contentSha256, sha(value));
  assert.equal(actual.originalBytes, Buffer.byteLength(JSON.stringify(value)));
  assert.deepEqual(actual.hints, { status: "ready", running: 3 });
  assert.equal(actual.detailsReturned, false);
  assert.equal(actual.detailsRetained, false);
  assert.equal(actual.detailsRequireNewAuthorizedToolCall, true);
  assert.ok(!JSON.stringify(actual).includes("VERY_PRIVATE_SOURCE_DATA"));
  assert.ok(!JSON.stringify(actual).includes("DO_NOT_LEAK"));
  assert.ok(JSON.stringify(actual).length < 500);
});

test("full-fidelity evidence is not falsely claimed and nested values never leak", () => {
  const actual = compactReadBatchResult({
    key: "task",
    tool: "autopilot_status",
    ok: true,
    value: {
      status: "TOKEN_VALUE_DO_NOT_ECHO",
      activeCount: 8,
      failed: 1,
      available: false,
      metadata: ["MY_SECRET"],
    },
  });
  assert.deepEqual(actual.hints, {
    available: false,
    activeCount: 8,
    failed: 1,
  });
  assert.equal(actual.externallyVerified, false);
  assert.equal(actual.detailsReturned, false);
  assert.ok(!JSON.stringify(actual).includes("MY_SECRET"));
  assert.ok(!JSON.stringify(actual).includes("TOKEN_VALUE"));
});

test("array outputs report count only and require a new authorized read", () => {
  const source = [{ token: "SECRET" }, { token: "ANOTHER" }];
  const r = compactReadBatchResult({
    key: "entries",
    tool: "list_project_jobs",
    ok: true,
    value: source,
  });
  assert.equal(r.itemCount, 2);
  assert.equal(r.shape, "array");
  assert.deepEqual(r.hints, {});
  assert.ok(!JSON.stringify(r).includes("SECRET"));
});

test("errors remain visible but unsafe, untrusted error strings fail closed", () => {
  const result = compactReadBatchResult({
    key: "read",
    tool: "read_file",
    ok: false,
    error: "PROJECT_NOT_FOUND",
  });
  assert.deepEqual(result, {
    key: "read",
    tool: "read_file",
    ok: false,
    error: "PROJECT_NOT_FOUND",
  });
  const unsafe = compactReadBatchResult({
    key: "read",
    tool: "read_file",
    ok: false,
    error: "secret=sensitive\nTOKEN",
  });
  assert.equal(unsafe.error, "TOOL_CALL_FAILED");
});

test("rejects malformed records instead of silently returning fake evidence", () => {
  for (const row of [null, [], { key: 2, tool: "read_file" }, { key: "one" }])
    assert.throws(
      () => compactReadBatchResult(row),
      /COMPACT_READ_INVALID_ROW/,
    );
});

test("displays safe numeric/boolean state but excludes arbitrary strings", () => {
  const r = compactReadBatchResult({
    key: "one",
    tool: "inspect_project",
    ok: true,
    value: {
      ready: true,
      count: 2147483648,
      total: 42,
      state: "running",
      blocked: false,
      writable: true,
      revision: -1,
    },
  });
  assert.deepEqual(r.hints, {
    state: "running",
    ready: true,
    blocked: false,
    writable: true,
    total: 42,
  });
});
