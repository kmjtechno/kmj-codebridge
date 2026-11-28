import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compactIdeJobReceipt } from "../src/ide-job-receipt.js";

const job = (overrides = {}) => ({
  id: "job_safe_1",
  state: "succeeded",
  exitCode: 0,
  output: [
    "Build complete",
    "CTEST_Debug=PASS",
    "CTEST_Release=PASS",
    "HARDWARE_ACTIVITY=NONE",
    "CALIBRATION_RELEASE_APPROVED=NO",
    "token=plaintext-exfiltration-example",
    "API_KEY=SHOULD_NEVER_APPEAR",
  ].join("\n"),
  ...overrides,
});

test("returns compact verified runner state, not full logs or fake release approval", () => {
  const result = compactIdeJobReceipt(job());
  assert.equal(result.state, "succeeded");
  assert.equal(result.executionSucceeded, true);
  assert.equal(result.approvalOrDeploymentProven, false);
  assert.deepEqual(
    result.markers.map((m) => m.key),
    [
      "CTEST_Debug",
      "CTEST_Release",
      "HARDWARE_ACTIVITY",
      "CALIBRATION_RELEASE_APPROVED",
    ],
  );
  assert.ok(!JSON.stringify(result).includes("plaintext-exfiltration-example"));
  assert.ok(!JSON.stringify(result).includes("SHOULD_NEVER_APPEAR"));
  assert.match(result.logSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.logTailAvailableVia, "get_job_status");
});

test("a project printing PASS cannot turn failed or queued job into verified completion", () => {
  for (const [state, exit] of [
    ["failed", 1],
    ["queued", null],
    ["running", null],
    ["cancelled", null],
    ["timed_out", null],
  ]) {
    const result = compactIdeJobReceipt(job({ state, exitCode: exit }));
    assert.equal(result.executionSucceeded, false);
    assert.equal(result.approvalOrDeploymentProven, false);
  }
});

test("rejects untrusted job identity and sanitizes unknown state", () => {
  assert.throws(
    () => compactIdeJobReceipt({ id: "../private", state: "succeeded" }),
    /IDE_JOB_INVALID/,
  );
  assert.equal(
    compactIdeJobReceipt(job({ state: "FAKE_SUCCEEDED" })).state,
    "unknown",
  );
});

test("limits marker output even when untrusted project prints many log lines", () => {
  const output = Array.from(
    { length: 80 },
    (_, i) => "TEST_CASE" + i + "=PASS",
  ).join("\n");
  const result = compactIdeJobReceipt(job({ output }));
  assert.equal(result.markers.length, 16);
  assert.equal(result.markersTruncated, true);
});

test("redacts sensitive-looking markers and malformed lines", () => {
  const result = compactIdeJobReceipt(
    job({
      output: [
        "BUILD_TOKEN=1234",
        "TEST_PRIVATE_KEY=0",
        "HARDWARE_SECRET=1",
        "TEST_RUN=PASS",
        "TEST_RUN=WITH SPACES",
        "TEST_RUN=fail;rm -rf /",
        "EXACT_SOURCE_SHA=" + "a".repeat(40),
      ].join("\n"),
    }),
  );
  assert.deepEqual(
    result.markers.map((m) => m.key),
    ["TEST_RUN", "EXACT_SOURCE_SHA"],
  );
});

test("MCP dispatcher reuses policy-gated, idempotent project command; no raw shell", () => {
  const source = fs.readFileSync(path.resolve("src/tools.js"), "utf8");
  assert.match(source, /ide_run_project_task: \{/);
  assert.match(source, /ide_job_receipt: \{/);
  assert.match(source, /if \(name === "ide_run_project_task"\) \{/);
  assert.match(source, /dispatchCore\s*\(\s*"run_project_command"/);
  assert.match(source, /dispatchCore\s*\(\s*"get_job_status"/);
  assert.match(source, /IDE_COMMAND_NOT_CONFIGURED/);
  assert.match(source, /permissions\.includes\("read"\)/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf('if (name === "ide_run_project_task")'),
      source.indexOf('if (name === "run_project_command")'),
    ),
    /\b(?:spawn|exec|eval)\s*\(/,
  );
});

test("receipt digest binds gate, state, exit code and log hash and is stable", () => {
  const base = job({
    gate: "command:cmake_test:debug:build@lane#" + "a".repeat(40),
    startedAt: "2026-11-08T10:00:00.000Z",
    endedAt: "2026-11-08T10:01:00.000Z",
    truncated: false,
  });
  const a = compactIdeJobReceipt(base);
  assert.match(a.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(a.gate, base.gate);
  assert.equal(compactIdeJobReceipt(base).receiptSha256, a.receiptSha256);
  for (const change of [
    { exitCode: 1 },
    { state: "failed" },
    { output: "different" },
    { gate: "command:cmake_test:release:build@lane#" + "b".repeat(40) },
    { truncated: true },
  ])
    assert.notEqual(
      compactIdeJobReceipt({ ...base, ...change }).receiptSha256,
      a.receiptSha256,
    );
});

test("hostile gate or timestamp strings are dropped, not echoed", () => {
  const r = compactIdeJobReceipt(
    job({ gate: "x\nTOKEN=abc;rm -rf /", startedAt: "<script>" }),
  );
  assert.equal(r.gate, null);
  assert.equal(r.startedAt, null);
});

test("deduplicates repeated markers without hiding conflicting statuses", () => {
  const output = [
    ...Array(30).fill("TEST_RETRY=PASS"),
    "TEST_RETRY=FAIL",
    "TEST_RETRY=PASS",
  ].join("\n");
  const result = compactIdeJobReceipt(
    job({ output, state: "failed", exitCode: 1 }),
  );
  assert.deepEqual(result.markers, [
    { key: "TEST_RETRY", value: "FAIL" },
    { key: "TEST_RETRY", value: "PASS" },
  ]);
  assert.equal(result.repeatedMarkers, 30);
  assert.equal(result.executionSucceeded, false);
  assert.equal(result.markersTruncated, false);
});

test("numeric test summaries are bounded, unverified and do not copy logs", () => {
  const output = [
    "100% tests passed, 0 tests failed out of 3",
    "19 passed, 34 subtests passed in 0.52s",
    "test result: ok. 5 passed; 0 failed; 1 ignored; 0 measured; 3 filtered out; finished in 0.02s",
    "SECRET=not-for-chat",
  ].join("\n");
  const result = compactIdeJobReceipt(
    job({ output, state: "failed", exitCode: 1 }),
  );
  assert.deepEqual(result.testSummaries, [
    { framework: "ctest", total: 3, failed: 0, passed: 3 },
    { framework: "pytest", passed: 19, subtestsPassed: 34 },
    {
      framework: "cargo",
      passed: 5,
      failed: 0,
      ignored: 1,
      measured: 0,
      filteredOut: 3,
    },
  ]);
  assert.equal(result.testSummariesVerified, false);
  assert.equal(result.executionSucceeded, false);
  assert.ok(!JSON.stringify(result).includes("not-for-chat"));
});
