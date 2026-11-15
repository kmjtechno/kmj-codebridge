import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(
  "scripts/production/owner_roll_signed_latest_feed_20261115.py",
  "utf8",
);

test("rolling feed retains signature, antirollback and atomic previous-pair recovery", () => {
  for (const marker of [
    "OWNER_SPKI",
    "SIGNED_SEQUENCE_DUPLICATE",
    "SIGNED_SEQUENCE_ROLLBACK",
    "ROLLBACK_SOURCE_UNVERIFIED",
    "SIGNED_SEQUENCE_EQUIVOCATION",
    "PUBLIC_READBACK_FAILED_PREVIOUS_FEED_RESTORED",
    "PREVIOUS_SIGNED_PAIR=PRESERVED",
    "RENAME_EXCHANGE",
    "PRODUCTION_SERVICE_MUTATION=NONE",
  ]) {
    assert.match(source, new RegExp(marker));
  }
  assert.doesNotMatch(source, /shell=True|os\.system|git pull|rm -rf/);
});

test(
  "offline rolling signed-feed fixtures pass on Linux",
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
        "test_owner_roll_signed_latest_feed.py",
        "-v",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(run.status, 0, String(run.stderr || run.error).slice(-4000));
    assert.match(run.stderr, /Ran 13 tests/);
  },
);
