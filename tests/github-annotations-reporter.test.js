import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("failing tests become bounded GitHub error annotations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-rep-"));
  try {
    const file = path.join(dir, "sample.test.mjs");
    fs.writeFileSync(
      file,
      'import test from "node:test";import assert from "node:assert/strict";' +
        'test("deliberate failure",()=>assert.equal(1,2));test("fine",()=>{});',
    );
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        `--test-reporter=${path.resolve("scripts/github-annotations-reporter.mjs")}`,
        file,
      ],
      {
        encoding: "utf8",
        // A nested `node --test` inside a test run would otherwise attach to
        // the parent runner instead of reporting on its own.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );
    assert.notEqual(result.status, 0);
    const lines = result.stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith("::error"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /title=Test failed::deliberate failure/);
    assert.match(lines[0], /expected=2/);
    assert.ok(!lines[0].includes("\n"));
    assert.ok(lines[0].length < 700);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
