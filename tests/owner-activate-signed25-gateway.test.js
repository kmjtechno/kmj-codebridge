import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "scripts/production/";
const seq24 = fs.readFileSync(
  dir + "owner_activate_signed24_gateway_20261113.py",
  "utf8",
);
const seq25 = fs.readFileSync(
  dir + "owner_activate_signed25_gateway_20261114.py",
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

test("seq25 gateway script is structurally identical to reviewed seq24", () => {
  assert.equal(normalise(seq25), normalise(seq24));
});

test("seq25 old/rollback side is the live signed24 override", () => {
  assert.match(seq25, /OLD_CONF = DIR \/ "zzzzzzzz-kmj-signed24\.conf"/);
  assert.match(
    seq25,
    /PREVIOUS_SHA = "dd1ccf3232f9678df6e8e87172c36ff4397c0cac"/,
  );
  assert.match(seq25, /0\.3\.2-dd1ccf3232f9"\)\nNEW_DIR/);
  assert.match(seq25, /NEW_CONF = DIR \/ "zzzzzzzzz-kmj-signed25\.conf"/);
  assert.match(seq25, /NEW_SHA = "55a3f976fd3b71e36b4dcb1864b04d43364418ac"/);
  assert.doesNotMatch(seq25, /37a6627b|signed23|SIGNED23/);
});

test("seq25 new override sorts after every existing drop-in and dry-run is default", () => {
  const existing = [
    "90-github-readonly.conf",
    "99-kmj-pinned-runtime.conf",
    "zzzz-kmj-signed14.conf",
    "zzzz-kmj-signed15.conf",
    "zzzz-kmj-signed17.conf",
    "zzzzz-kmj-source-commit.conf",
    "zzzzzz-kmj-signed22.conf",
    "zzzzzzz-kmj-signed23.conf",
    "zzzzzzzz-kmj-signed24.conf",
  ];
  for (const name of existing) assert.ok(name < "zzzzzzzzz-kmj-signed25.conf");
  assert.match(
    seq25,
    /sys\.argv\[1:\] in \(\[\],\["--apply","--confirm-no-active-jobs"\]\)/,
  );
  assert.match(seq25, /SIGNED25_GATEWAY=DRY_RUN_UNCHANGED/);
});
