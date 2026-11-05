import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Main Platform snapshot consumer preserves source and dependency gates", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "tests",
    "-p", "test_main_platform_storage_snapshot_consumer.py", "-v"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stderr, /Ran 13 tests/);
});
