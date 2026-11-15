import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "scripts/production/";
const seq27 = fs.readFileSync(
  dir + "owner_activate_signed27_gateway_20261115.py",
  "utf8",
);
const seq28 = fs.readFileSync(
  dir + "owner_activate_signed28_gateway_20261115.py",
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

test("seq28 gateway script is structurally identical to the seq27 script that went live", () => {
  assert.equal(normalise(seq28), normalise(seq27));
  assert.match(seq28, /GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER/);
});

test("seq28 rollback side is the live signed27 override, new side is signed28", () => {
  assert.match(seq28, /OLD_CONF = DIR \/ "zzzzzzzzzz-kmj-signed27\.conf"/);
  assert.match(
    seq28,
    /PREVIOUS_SHA = "40655678db7fa62edca28ccc4988614010253ef1"/,
  );
  assert.match(seq28, /0\.3\.2-40655678db7f"\)\nNEW_DIR/);
  assert.match(seq28, /NEW_CONF = DIR \/ "zzzzzzzzzzz-kmj-signed28\.conf"/);
  assert.match(seq28, /NEW_SHA = "f2a18a1feb0aa9df8b888ae363e4cc96b769c83b"/);
  assert.match(seq28, /0\.3\.2-f2a18a1feb0a"\)/);
  assert.match(seq28, /SIGNED27_OVERRIDE_DRIFT/);
  assert.doesNotMatch(seq28, /SIGNED25|signed25|55a3f976|2e8c4b7d|signed26/);
});

test("seq28 override sorts after every live drop-in and is dry-run by default", () => {
  const live = [
    "90-github-readonly.conf",
    "99-kmj-pinned-runtime.conf",
    "zzzz-kmj-signed14.conf",
    "zzzzz-kmj-source-commit.conf",
    "zzzzzzzzz-kmj-signed25.conf",
    "zzzzzzzzzz-kmj-signed27.conf",
  ];
  const next = "zzzzzzzzzzz-kmj-signed28.conf";
  assert.deepEqual([...live, next].sort().at(-1), next);
  assert.match(seq28, /SIGNED28_GATEWAY=DRY_RUN_UNCHANGED/);
  assert.match(seq28, /--confirm-no-active-jobs/);
});

test("seq28 script never edits the gateway config, updater or agent", () => {
  assert.doesNotMatch(seq28, /chown|os\.chmod\(|stable-update\.json/);
  assert.match(seq28, /Never touch keys, updater, agent/);
});
