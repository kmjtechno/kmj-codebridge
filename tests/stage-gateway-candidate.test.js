import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/stage-gateway-candidate.sh", import.meta.url),
);
const source = fs.readFileSync(script, "utf8");

test("operator staging is SHA-pinned, local, fail-closed and never restarts live gateway", () => {
  for (const guard of [
    "STAGING=BLOCKED_INVALID_SHA",
    "STAGING=BLOCKED_WRONG_HOST_OR_USER",
    "STAGING=BLOCKED_CANDIDATE_EXISTS",
    "GIT_TERMINAL_PROMPT=0",
    "STAGING_GATE=$gate",
    "status --porcelain",
    "npm --prefix",
    "ci --ignore-scripts",
    "APPLY=NOT_REQUESTED",
  ]) {
    assert.ok(source.includes(guard), guard);
  }
  assert.match(source, /for gate in check test scan:secrets/);
  assert.match(source, /--depth 1 --no-tags/);
  assert.doesNotMatch(source, /systemctl\s+(?:restart|stop)|--apply/);
  assert.doesNotMatch(source, /git\s+reset\s+--hard|git\s+clean\s+-f/);
});

test(
  "bash syntax and invalid SHA are rejected before privileged operations",
  { skip: process.platform === "win32" },
  () => {
    const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    for (const args of [[], ["main"], ["a".repeat(39)], ["A".repeat(40)]]) {
      const result = spawnSync("bash", [script, ...args], {
        encoding: "utf8",
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /STAGING=BLOCKED_INVALID_SHA/);
    }
  },
);
