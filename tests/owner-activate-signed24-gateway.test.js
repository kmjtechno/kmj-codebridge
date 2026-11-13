import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "scripts/production/";
const seq23 = fs.readFileSync(
  dir + "owner_activate_signed23_gateway_20261113.py",
  "utf8",
);
const seq24 = fs.readFileSync(
  dir + "owner_activate_signed24_gateway_20261113.py",
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

test("seq24 gateway script is structurally identical to reviewed seq23", () => {
  assert.equal(normalise(seq24), normalise(seq23));
});

test("seq24 old/rollback side is the live signed23 override", () => {
  assert.match(seq24, /OLD_CONF = DIR \/ "zzzzzzz-kmj-signed23\.conf"/);
  assert.match(
    seq24,
    /PREVIOUS_SHA = "37a6627bff6435a29d6b2863a0304db6e41a680b"/,
  );
  assert.match(seq24, /0\.3\.2-37a6627bff64"\)\nNEW_DIR/);
  assert.match(seq24, /NEW_CONF = DIR \/ "zzzzzzzz-kmj-signed24\.conf"/);
  assert.match(seq24, /NEW_SHA = "dd1ccf3232f9678df6e8e87172c36ff4397c0cac"/);
  assert.doesNotMatch(seq24, /0bf9b3cc|signed22|SIGNED22/);
});

test("seq24 new override sorts after every existing drop-in and dry-run is default", () => {
  const existing = [
    "90-github-readonly.conf",
    "99-kmj-pinned-runtime.conf",
    "zzzz-kmj-signed14.conf",
    "zzzz-kmj-signed15.conf",
    "zzzz-kmj-signed17.conf",
    "zzzzz-kmj-source-commit.conf",
    "zzzzzz-kmj-signed22.conf",
    "zzzzzzz-kmj-signed23.conf",
  ];
  for (const name of existing) assert.ok(name < "zzzzzzzz-kmj-signed24.conf");
  assert.match(
    seq24,
    /sys\.argv\[1:\] in \(\[\],\["--apply","--confirm-no-active-jobs"\]\)/,
  );
  assert.match(seq24, /SIGNED24_GATEWAY=DRY_RUN_UNCHANGED/);
});
