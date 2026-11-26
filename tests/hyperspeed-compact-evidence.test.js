import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptiveReadBatchResult,
  compactReadBatchResult,
} from "../src/compact-read-results.js";

const row = (tool, value) => ({ key: "status", tool, ok: true, value });
const hints = (tool, value) => compactReadBatchResult(row(tool, value)).hints;

test("Git status exposes counts and divergence without paths or branch names", () => {
  const status =
    "## private-branch...origin/private-branch [ahead 2, behind 908]\n" +
    " M private/path.txt\nUU private/conflict.txt\n?? private/untracked.txt\n";
  const result = compactReadBatchResult(row("git_status", { status }));
  assert.deepEqual(result.hints, {
    gitDirty: true,
    gitTrackedRows: 2,
    gitUntrackedRows: 1,
    gitConflictRows: 1,
    gitAhead: 2,
    gitBehind: 908,
  });
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("clean, unknown and malformed Git states are not conflated", () => {
  assert.deepEqual(hints("git_status", { status: "## main\n" }), {
    gitDirty: false,
    gitTrackedRows: 0,
    gitUntrackedRows: 0,
    gitConflictRows: 0,
  });
  for (const status of [
    "unexpected",
    "## main\nBROKEN",
    "## main\n!! ignored\n",
    "## main\n??",
    null,
  ]) {
    assert.deepEqual(hints("git_status", { status }), {});
  }
  assert.equal(
    hints("git_status", { status: "## main...origin/main [behind 7]\n" })
      .gitBehind,
    7,
  );
  assert.equal(
    hints("git_status", { status: "## main [ahead 9999999999]\n" }).gitAhead,
    undefined,
  );
});

test("project snapshot preserves availability and nested Git state only", () => {
  assert.deepEqual(
    hints("project_snapshot", {
      writable: true,
      git: { available: true, status: "## main\n?? private.txt\n" },
      entriesTruncated: true,
      entries: [{ path: "private.txt" }],
    }),
    {
      writable: true,
      gitAvailable: true,
      gitDirty: true,
      gitTrackedRows: 0,
      gitUntrackedRows: 1,
      gitConflictRows: 0,
      entriesTruncated: true,
    },
  );
  assert.deepEqual(
    hints("project_snapshot", {
      git: { available: false, status: "## main\n" },
    }),
    { gitAvailable: false },
  );
});

test("capacity preserves bounded scheduling facts, never raw reasons", () => {
  const value = {
    blocked: false,
    constrained: true,
    effectiveMaxConcurrent: 4,
    activeJobs: 2,
    queuedJobs: 9,
    journalRemaining: 11,
    blockReason: "PRIVATE_REASON",
    archiveRemaining: -1,
  };
  const result = compactReadBatchResult(row("execution_capacity", value));
  assert.deepEqual(result.hints, {
    blocked: false,
    constrained: true,
    effectiveMaxConcurrent: 4,
    activeJobs: 2,
    queuedJobs: 9,
    journalRemaining: 11,
    availableAuthorizedSlots: 2,
  });
  assert.ok(!JSON.stringify(result).includes("PRIVATE_REASON"));
  assert.equal(
    hints("execution_capacity", { ...value, blocked: true })
      .availableAuthorizedSlots,
    0,
  );
  assert.equal(
    hints("execution_capacity", { ...value, activeJobs: "2" })
      .availableAuthorizedSlots,
    undefined,
  );
});

test("adaptive mode keeps material savings and meaningful evidence", () => {
  const status =
    "## main...origin/main [behind 908]\n" +
    Array.from({ length: 250 }, (_, i) => "?? private/" + i + ".txt\n").join(
      "",
    );
  const input = row("git_status", { status });
  const result = adaptiveReadBatchResult(input);
  assert.equal(result.responseMode, "compact");
  assert.equal(result.hints.gitBehind, 908);
  assert.equal(result.hints.gitUntrackedRows, 250);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) * 5 <=
      Buffer.byteLength(JSON.stringify(input)) * 4,
  );
  assert.ok(!JSON.stringify(result).includes("private/"));
});
