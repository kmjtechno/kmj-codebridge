import test from "node:test";
import assert from "node:assert/strict";
import { buildMissionWorkspace } from "../src/mission-control-workspace.js";

const NOW = Date.parse("2026-10-16T04:00:00.000Z");
const scopedTree = () => ({
  ok: true,
  value: {
    path: "",
    truncated: false,
    entries: [
      { path: "src", type: "directory", depth: 0 },
      { path: "src/tools.js", type: "file", depth: 1, secret: "DO_NOT_ECHO" },
      { path: "README.md", type: "file", depth: 0 },
    ],
  },
});
const scopedDiff = () => ({
  ok: true,
  value: {
    diff: "diff --git a/src/tools.js b/src/tools.js\n--- a/src/tools.js\n+++ b/src/tools.js\n@@ -1 +1 @@\n-old\n+new\n",
    truncated: false,
    output: "UNSAFE_COMMAND_ARGUMENTS",
  },
});

test("authorized, bounded project file names and tracked patch are returned", () => {
  const result = buildMissionWorkspace({
    project: "project1",
    tree: scopedTree(),
    diff: scopedDiff(),
    now: NOW,
  });
  assert.equal(result.source, "AUTHORIZED_PROJECT_READS");
  assert.equal(result.observedAt, "2026-10-16T04:00:00.000Z");
  assert.equal(result.tree.status, "AVAILABLE");
  assert.deepEqual(result.tree.entries[1], {
    path: "src/tools.js",
    type: "file",
    depth: 1,
  });
  assert.equal(result.diff.status, "AVAILABLE");
  assert.match(result.diff.patch, /^diff --git a\/src\/tools.js/);
  assert.equal(result.tree.truncated, false);
  assert.equal(result.diff.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_ECHO|UNSAFE_COMMAND_ARGUMENTS/);
});

test("no trusted tool evidence remains UNKNOWN, not an empty repository", () => {
  const snapshot = buildMissionWorkspace({
    project: "project1",
    tree: { ok: false },
    diff: { ok: false },
    now: NOW,
  });
  assert.equal(snapshot.tree.status, "UNAVAILABLE");
  assert.equal(snapshot.diff.status, "UNAVAILABLE");
  assert.deepEqual(snapshot.tree.entries, []);
  assert.equal(snapshot.diff.patch, null);
});

test("reject traversal, secret paths and symlinks if bad tool data is returned", () => {
  for (const path of [
    "../private.key",
    ".env",
    ".git/config",
    "src/../../private",
    "src\\somefile",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "node_modules/token.js",
  ]) {
    const tree = scopedTree();
    tree.value.entries[1].path = path;
    assert.equal(
      buildMissionWorkspace({
        project: "project1",
        tree,
        diff: { ok: false },
        now: NOW,
      }).tree.status,
      "UNAVAILABLE",
    );
  }
});

test("large patch is clearly truncated without claiming full coverage", () => {
  const diff = scopedDiff();
  diff.value.diff = "a".repeat(30000);
  const s = buildMissionWorkspace({
    project: "project1",
    tree: scopedTree(),
    diff,
    now: NOW,
  });
  assert.equal(s.diff.patch.length, 24576);
  assert.equal(s.diff.truncated, true);
});

test("invalid tree shapes do not partially show unauthorized entries", () => {
  const tree = scopedTree();
  tree.value.entries[1].depth = 100;
  const x = buildMissionWorkspace({
    project: "project1",
    tree,
    diff: scopedDiff(),
    now: NOW,
  });
  assert.equal(x.tree.status, "UNAVAILABLE");
  assert.deepEqual(x.tree.entries, []);
  assert.equal(x.diff.status, "AVAILABLE");
});
