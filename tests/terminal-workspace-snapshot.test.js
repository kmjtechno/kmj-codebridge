import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles, hash } from "../src/policy.js";
import { planTerminalWorkspaceSnapshot } from "../src/terminal-workspace-snapshot.js";

const head = "a".repeat(40);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-terminal-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\r\n");
  fs.writeFileSync(path.join(root, "b.txt"), "beta\n");
  fs.writeFileSync(path.join(root, ".env"), "private");
  return {
    files: new ProjectFiles(root),
    readHead: () => head,
    expectedHead: head,
    entries: [
      { path: "a.txt", sha256: hash("alpha\r\n") },
      { path: "b.txt", sha256: hash("beta\n") },
    ],
  };
}

test("selected workspace plan is deterministic and returns no contents", (t) => {
  const options = fixture(t);
  const a = planTerminalWorkspaceSnapshot(options);
  const b = planTerminalWorkspaceSnapshot({
    ...options,
    entries: [...options.entries].reverse(),
  });
  assert.deepEqual(a, b);
  assert.equal(a.bytes, 12);
  assert.equal(a.transferred, false);
  assert.match(a.manifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(a).includes("alpha"));
});

test("stale head, stale bytes and case aliases fail closed", (t) => {
  const options = fixture(t);
  assert.throws(
    () =>
      planTerminalWorkspaceSnapshot({
        ...options,
        readHead: () => "b".repeat(40),
      }),
    /TERMINAL_SNAPSHOT_HEAD_MISMATCH/,
  );
  assert.throws(
    () =>
      planTerminalWorkspaceSnapshot({
        ...options,
        entries: [{ path: "a.txt", sha256: "b".repeat(64) }],
      }),
    /TERMINAL_SNAPSHOT_CONTENT_MISMATCH/,
  );
  assert.throws(
    () =>
      planTerminalWorkspaceSnapshot({
        ...options,
        entries: [
          ...options.entries,
          { path: "A.txt", sha256: hash("alpha\r\n") },
        ],
      }),
    /TERMINAL_SNAPSHOT_PATH_COLLISION/,
  );
});

test("path policy remains authoritative and HEAD is checked after reading", (t) => {
  const options = fixture(t);
  for (const filename of ["../a.txt", ".env", "node_modules/private.txt"]) {
    assert.throws(() =>
      planTerminalWorkspaceSnapshot({
        ...options,
        entries: [{ path: filename, sha256: hash("private") }],
      }),
    );
  }
  let reads = 0;
  assert.throws(
    () =>
      planTerminalWorkspaceSnapshot({
        ...options,
        readHead: () => (++reads === 1 ? head : "b".repeat(40)),
      }),
    /TERMINAL_SNAPSHOT_HEAD_MISMATCH/,
  );
});
