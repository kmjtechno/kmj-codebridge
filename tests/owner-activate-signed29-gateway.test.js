import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "scripts/production/";
const seq28 = fs.readFileSync(
  dir + "owner_activate_signed28_gateway_20261115.py",
  "utf8",
);
const seq29 = fs.readFileSync(
  dir + "owner_activate_signed29_gateway_20261116.py",
  "utf8",
);

// Normalise every release-specific identifier so only structure is compared.
const normalise = (text) =>
  text
    .replace(/REQUIRED = frozenset\(\[[\s\S]*?\]\)\n/, "REQUIRED = SET\n")
    .replace(/z+-kmj-signed\d+\.conf/g, "ZCONF")
    .replace(/SIGNED\d+/g, "SIGNEDN")
    .replace(/signed\d+/g, "signedN")
    .replace(/stable\d+/g, "stableN")
    .replace(/\b[0-9a-f]{40}\b/g, "FULLSHA")
    .replace(/0\.3\.2-[0-9a-f]{12}/g, "RELDIR");

test("seq29 gateway script is structurally identical to the seq28 script that went live", () => {
  assert.equal(normalise(seq29), normalise(seq28));
  assert.match(seq29, /GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER/);
});

test("seq29 rollback side is the live signed28 override, new side is signed29", () => {
  assert.match(seq29, /OLD_CONF = DIR \/ "zzzzzzzzzzz-kmj-signed28\.conf"/);
  assert.match(
    seq29,
    /PREVIOUS_SHA = "f2a18a1feb0aa9df8b888ae363e4cc96b769c83b"/,
  );
  assert.match(seq29, /0\.3\.2-f2a18a1feb0a"\)\nNEW_DIR/);
  assert.match(seq29, /NEW_CONF = DIR \/ "zzzzzzzzzzzz-kmj-signed29\.conf"/);
  assert.match(seq29, /NEW_SHA = "e8c353dc839a01a8418e01e7b9209d46bcedc779"/);
  assert.match(seq29, /0\.3\.2-e8c353dc839a"\)/);
  assert.match(seq29, /SIGNED28_OVERRIDE_DRIFT/);
  assert.doesNotMatch(seq29, /signed27|SIGNED27|40655678|signed25|SIGNED25/);
});

test("seq29 identities match the owner-signed manifest merged on main", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      "releases/stable/e8c353dc839a01a8418e01e7b9209d46bcedc779/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(manifest.sequence, 29);
  assert.equal(manifest.revision, seq29.match(/NEW_SHA = "([0-9a-f]{40})"/)[1]);
  assert.equal(
    "0.3.2-" + manifest.revision.slice(0, 12),
    seq29.match(
      /NEW_DIR = pathlib\.Path\("[^"]*\/(0\.3\.2-[0-9a-f]{12})"\)/,
    )[1],
  );
  const live = JSON.parse(
    fs.readFileSync(
      "releases/stable/f2a18a1feb0aa9df8b888ae363e4cc96b769c83b/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(live.sequence, 28);
  assert.equal(
    live.revision,
    seq29.match(/PREVIOUS_SHA = "([0-9a-f]{40})"/)[1],
  );
});

test("seq29 override sorts after every live drop-in and is dry-run by default", () => {
  const live = [
    "90-github-readonly.conf",
    "99-kmj-pinned-runtime.conf",
    "zzzz-kmj-signed14.conf",
    "zzzzz-kmj-source-commit.conf",
    "zzzzzzzzz-kmj-signed25.conf",
    "zzzzzzzzzz-kmj-signed27.conf",
    "zzzzzzzzzzz-kmj-signed28.conf",
  ];
  const next = "zzzzzzzzzzzz-kmj-signed29.conf";
  assert.deepEqual([...live, next].sort().at(-1), next);
  assert.match(seq29, /SIGNED29_GATEWAY=DRY_RUN_UNCHANGED/);
  assert.match(seq29, /--confirm-no-active-jobs/);
});

test("seq29 requires the tools added since seq28 and still never edits config, updater or agent", () => {
  for (const tool of [
    "freellmapi_status",
    "freellmapi_generate",
    "worktree_lane_diagnose",
  ]) {
    assert.match(seq29, new RegExp(`"${tool}"`));
    assert.match(
      fs.readFileSync("src/tools.js", "utf8"),
      new RegExp(`"${tool}"`),
    );
  }
  assert.doesNotMatch(seq29, /chown|os\.chmod\(|stable-update\.json/);
});
