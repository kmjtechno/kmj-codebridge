import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(
  "scripts/production/owner_publish_seq27_signed_latest_feed_20261115.py",
  "utf8",
);

test("owner-only immutable signed27 feed cannot overwrite an existing latest pair", () => {
  for (const marker of [
    "OWNER_SPKI_SHA",
    "SIGNED27_ARCHIVE_SHA_MISMATCH",
    "SIGNED27_MANIFEST_SHA_MISMATCH",
    "EXISTING_FEED_CONTENTS_UNEXPECTED",
    "ATOMIC_NOREPLACE_FAILED",
    "PUBLIC_RELEASE_BYTES_MISMATCH",
    "AUTO_UPDATE_TIMER=UNCHANGED",
    "SERVICE_OR_CONFIG_MUTATION=NONE",
  ]) {
    assert.match(source, new RegExp(marker));
  }
  assert.doesNotMatch(source, /shell=True|os\.system|git pull|rm -rf/);
});

test(
  "isolated latest signed-feed Python fixtures pass on Linux",
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
        "test_owner_publish_seq27_signed_latest_feed.py",
        "-v",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(run.status, 0, String(run.stderr || run.error).slice(-4000));
    assert.match(run.stderr, /Ran 11 tests/);
  },
);
