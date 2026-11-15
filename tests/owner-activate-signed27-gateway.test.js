import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "scripts/production/";
const seq25 = fs.readFileSync(
  dir + "owner_activate_signed25_gateway_v2_20261114.py",
  "utf8",
);
const seq27 = fs.readFileSync(
  dir + "owner_activate_signed27_gateway_20261115.py",
  "utf8",
);

// Normalise every release-specific identifier so only structure is compared.
const normalise = (text) =>
  text
    .replace(/z+-kmj-signed\d+\.conf/g, "ZCONF")
    .replace(/SIGNED\d+/g, "SIGNEDN")
    .replace(/signed\d+/g, "signedN")
    .replace(/stable\d+/g, "stableN")
    .replace(/\b[0-9a-f]{40}\b/g, "FULLSHA")
    .replace(/0\.3\.2-[0-9a-f]{12}/g, "RELDIR");

test("seq27 gateway script is structurally identical to the seq25 v2 script that went live", () => {
  assert.equal(normalise(seq27), normalise(seq25));
  // v2's startable-config preflight is carried over.
  assert.match(seq27, /GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER/);
});

test("seq27 old/rollback side (seq26 was never deployed) is the live signed25 override", () => {
  assert.match(seq27, /OLD_CONF = DIR \/ "zzzzzzzzz-kmj-signed25\.conf"/);
  assert.match(
    seq27,
    /PREVIOUS_SHA = "55a3f976fd3b71e36b4dcb1864b04d43364418ac"/,
  );
  assert.match(seq27, /0\.3\.2-55a3f976fd3b"\)\nNEW_DIR/);
  assert.match(seq27, /NEW_CONF = DIR \/ "zzzzzzzzzz-kmj-signed27\.conf"/);
  assert.match(seq27, /NEW_SHA = "40655678db7fa62edca28ccc4988614010253ef1"/);
  assert.match(seq27, /0\.3\.2-40655678db7f"\)/);
  assert.doesNotMatch(
    seq27,
    /dd1ccf32|signed24|SIGNED24|2e8c4b7d|signed26|SIGNED26/,
  );
});

test("seq27 override sorts after every live drop-in and is dry-run by default", () => {
  const live = [
    "90-github-readonly.conf",
    "99-kmj-pinned-runtime.conf",
    "zzzz-kmj-signed14.conf",
    "zzzz-kmj-signed15.conf",
    "zzzz-kmj-signed17.conf",
    "zzzzz-kmj-source-commit.conf",
    "zzzzzz-kmj-signed22.conf",
    "zzzzzzz-kmj-signed23.conf",
    "zzzzzzzz-kmj-signed24.conf",
    "zzzzzzzzz-kmj-signed25.conf",
  ];
  const next = "zzzzzzzzzz-kmj-signed27.conf";
  assert.deepEqual([...live, next].sort().at(-1), next);
  assert.match(seq27, /SIGNED27_GATEWAY=DRY_RUN_UNCHANGED/);
  assert.match(seq27, /--confirm-no-active-jobs/);
});
