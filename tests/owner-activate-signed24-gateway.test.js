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

test("seq24 gateway script differs from reviewed seq23 only by identifiers", () => {
  const expected = seq23
    .replaceAll("SIGNED23", "SIGNED24")
    .replaceAll("signed23", "signed24")
    .replaceAll("stable23", "stable24")
    .replace("0.3.2-37a6627bff64", "0.3.2-dd1ccf3232f9")
    .replace(
      "37a6627bff6435a29d6b2863a0304db6e41a680b",
      "dd1ccf3232f9678df6e8e87172c36ff4397c0cac",
    );
  assert.equal(seq24, expected);
});

test("rollback authority stays the signed22 override and dry-run is default", () => {
  assert.match(seq24, /OLD_CONF = DIR \/ "zzzzzz-kmj-signed22\.conf"/);
  assert.match(
    seq24,
    /PREVIOUS_SHA = "0bf9b3cc0c1ffb7555540ec66f1e26ec517bd624"/,
  );
  assert.match(seq24, /NEW_CONF = DIR \/ "zzzzzzz-kmj-signed24\.conf"/);
  assert.match(
    seq24,
    /sys\.argv\[1:\] in \(\[\],\["--apply","--confirm-no-active-jobs"\]\)/,
  );
  assert.match(seq24, /SIGNED24_GATEWAY=DRY_RUN_UNCHANGED/);
  assert.doesNotMatch(seq24, /37a6627bff/);
});
