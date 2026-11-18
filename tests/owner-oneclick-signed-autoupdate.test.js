import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(
  "scripts/production/owner_oneclick_signed_autoupdate.py",
  "utf8",
);

test("signed one-click auto-updater requires explicit owner policy and no unsigned fallback", () => {
  assert.match(source, /OWNER_POLICY_NOT_APPROVED/);
  assert.match(source, /OWNER_FP/);
  assert.match(source, /UNSIGNED_DEVELOPMENT_TIMER_CONFLICT/);
  assert.match(source, /SIGNED_FEED_METADATA_REJECTED/);
  assert.match(source, /UNSIGNED_GITHUB_MERGE_AUTOPROMOTION=DENIED/);
  assert.match(source, /GATEWAY_SUPERVISOR_AUTOPROMOTION=NOT_ENABLED/);
  assert.match(source, /AUTO_ENABLE_ROLLBACK_OWNER_REVIEW_REQUIRED/);
  assert.match(source, /SIGNED_TIMER_DISABLE_UNVERIFIED/);
  assert.match(source, /AUTO_CONFIG_BACKUP_UNVERIFIED/);
  assert.match(source, /ACTIVE_TIMER_FEED_NOT_ROLLING/);
  assert.match(source, /AUTO_CONFIG_SHORT_WRITE/);
  assert.doesNotMatch(source, /shell=True|os\.system|sudo -|rm -rf/);
});

test(
  "signed auto-update local safety fixtures pass on Linux",
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
        "test_owner_oneclick_signed_autoupdate.py",
        "-v",
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(run.status, 0, String(run.stderr || run.error).slice(-4000));
    assert.match(run.stderr, /Ran 18 tests/);
  },
);
