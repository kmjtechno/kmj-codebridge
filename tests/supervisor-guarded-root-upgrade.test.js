import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const script = fs.readFileSync(
  "scripts/production/upgrade-pinned-supervisor-runtime.sh",
  "utf8",
);

test("pinned upgrade requires root, host, reviewed clean SHA", () => {
  for (const required of [
    "ROOT_REQUIRED",
    "WRONG_HOST",
    "REVIEWED_SHA_REQUIRED",
    "SOURCE_HEAD_MISMATCH",
    "SOURCE_DIRTY",
    "SOURCE_LOCATION_UNTRUSTED",
    "SOURCE_OWNER_UNTRUSTED",
    "SOURCE_WRITABLE",
    "GIT_METADATA_WRITABLE",
    "NPM_PATH_OWNER_UNTRUSTED",
    "NPM_PATH_WRITABLE",
    "CURRENT_STAGE_UNTRUSTED",
    "NPM_PATH_UNTRUSTED",
    "NPM_TARGET_UNTRUSTED",
    "SOURCE_STAGING_FAILED",
    "STAGE_SHA_MISMATCH",
  ])
    assert.ok(script.includes(required), required);
  assert.match(script, /stage-supervisor-root-runtime\.sh/);
  assert.match(script, /\/opt\/kmj-codebridge-supervisor-stage\//);
});

test("socket handoff is idle-only, rollback-safe, and not a production deployment", () => {
  for (const required of [
    "SERVICE_BUSY_TRY_WHEN_IDLE",
    "SERVICE_BECAME_BUSY",
    "DROPIN_ALREADY_EXISTS",
    "EFFECTIVE_RUNTIME_MISMATCH",
    "EFFECTIVE_EXEC_MISMATCH",
    "SOCKET_RESTART_FAILED",
    "SUPERVISOR_UPGRADE_FAILED_ROLLBACK_ATTEMPTED",
    "AUTHENTICATED_CODEBRIDGE_MCP_VERIFICATION_REQUIRED",
  ])
    assert.ok(script.includes(required), required);
  assert.match(script, /systemd\/system\/\$UNIT\.d/);
  for (const fragment of [
    "git pull",
    "curl ",
    "wget ",
    "eval ",
    "sudoers",
    "reboot",
    "daemon-reexec",
    "systemctl restart",
    "/home/kmjprod/current",
  ]) {
    assert.ok(!script.includes(fragment), fragment);
  }
});

test(
  "pinned supervisor upgrade shell syntax",
  { skip: process.platform === "win32" },
  () => {
    const result = spawnSync(
      "bash",
      ["-n", "scripts/production/upgrade-pinned-supervisor-runtime.sh"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);
