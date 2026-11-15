import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(
  "scripts/production/owner_onepass_signed_agent_autoupdate_20261115.py",
  "utf8",
);

test("onepass signed auto-update never enables unsigned gateway or dynamic root commands", () => {
  for (const marker of [
    "OWNER_SPKI",
    "ONEPASS_INSTALLED_PATH_DRIFT",
    "UNAPPROVED_HELPER_PATH",
    "SIGNED_FEED_PREFLIGHT",
    "ONEPASS_PRIVATE_OWNER_APPROVAL=PASS",
    "EXISTING_SIGNED_FEED_UNVERIFIED",
    "LOCAL_PUBLIC_SIGNED_FEED_MISMATCH",
    "ONEPASS_SIGNED_AGENT_AUTOMATION=ENABLED",
    "GATEWAY_SUPERVISOR_WINDOWS_AUTOPROMOTION=NOT_ENABLED",
  ]) {
    assert.match(source, new RegExp(marker));
  }
  assert.doesNotMatch(source, /shell=True|os\.system|git pull|rm -rf/);
});

test(
  "isolated owner onepass activation safety tests pass on Linux",
  { skip: process.platform !== "linux" },
  () => {
    const run = spawnSync(
      "python3",
      [
        "-B",
        "-m",
        "unittest",
        "discover",
        "-s",
        "tests",
        "-p",
        "test_owner_onepass_signed_agent_autoupdate.py",
        "-v",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(run.status, 0, String(run.stderr || run.error).slice(-4000));
    assert.match(run.stderr, /Ran 12 tests/);
  },
);
