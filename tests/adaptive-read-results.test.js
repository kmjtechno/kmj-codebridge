import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptiveReadBatchResult,
  compactReadBatchResult,
} from "../src/compact-read-results.js";

test("small results are preserved exactly without a duplicate tool call", () => {
  const row = {
    key: "status",
    tool: "inspect_project",
    ok: true,
    value: { state: "running", count: 3, summary: "done" },
  };
  assert.strictEqual(adaptiveReadBatchResult(row), row);
  assert.deepEqual(adaptiveReadBatchResult(row).value, row.value);
});

test("large read results compact only when there is a material byte saving", () => {
  const row = {
    key: "source",
    tool: "read_file",
    ok: true,
    value: {
      status: "READY",
      secret: "DO_NOT_ECHO_PRIVATE_SOURCE".repeat(300),
      file: "src/private.txt",
    },
  };
  const actual = adaptiveReadBatchResult(row);
  assert.equal(actual.responseMode, "compact");
  assert.equal(actual.detailsReturned, false);
  assert.equal(actual.detailsRequireNewAuthorizedToolCall, true);
  assert.match(actual.contentSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(actual.hints, { status: "ready" });
  assert.ok(!JSON.stringify(actual).includes("DO_NOT_ECHO_PRIVATE_SOURCE"));
  assert.ok(
    Buffer.byteLength(JSON.stringify(actual)) * 5 <=
      Buffer.byteLength(JSON.stringify(row)) * 4,
  );
  assert.deepEqual(actual, compactReadBatchResult(row));
});

test("large but incompressible result is returned intact to avoid overhead", () => {
  const row = {
    key: "records",
    tool: "repo_map",
    ok: true,
    value: {
      report: "A".repeat(290),
      status: "ready",
    },
  };
  assert.strictEqual(adaptiveReadBatchResult(row), row);
});

test("failed read always returns a sanitized error rather than leaked details", () => {
  const row = {
    key: "one",
    tool: "search_code",
    ok: false,
    error: "secret=VERY_PRIVATE_KEY",
  };
  const output = adaptiveReadBatchResult(row);
  assert.equal(output.ok, false);
  assert.equal(output.error, "TOOL_CALL_FAILED");
  assert.ok(!JSON.stringify(output).includes("VERY_PRIVATE_KEY"));
});

test("adaptive mode is read-only and does not mutate its input", () => {
  const input = Object.freeze({
    key: "frozen",
    tool: "read_file",
    ok: true,
    value: Object.freeze({ content: "hello".repeat(1200) }),
  });
  const result = adaptiveReadBatchResult(input);
  assert.equal(result.responseMode, "compact");
  assert.equal(input.value.content.length, 6000);
  assert.equal(result.detailsRetained, false);
});

test("reject invalid rows instead of fabricating status", () => {
  for (const row of [null, [], { key: 12, tool: "read_file", ok: true }]) {
    assert.throws(
      () => adaptiveReadBatchResult(row),
      /COMPACT_READ_INVALID_ROW/,
    );
  }
});
