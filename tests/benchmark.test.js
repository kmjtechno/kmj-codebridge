import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("benchmark PID matcher ignores the benchmark process itself", (t) => {
  if (process.platform !== "linux") {
    t.skip("/proc PID matching is Linux-only");
    return;
  }

  const marker = "KMJ_BENCHMARK_SELF_MATCH_SENTINEL";
  const result = spawnSync(
    process.execPath,
    [
      "scripts/benchmark.js",
      "--idle-seconds=0",
      `--agent-match=${marker}`,
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.processIdle.supported, false);
  assert.match(
    parsed.processIdle.note,
    new RegExp(`agent: no process matched ".*${marker}"`),
  );
});
