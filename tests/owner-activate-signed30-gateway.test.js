import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "scripts/production/";
const seq29 = fs.readFileSync(
  dir + "owner_activate_signed29_gateway_20261116.py",
  "utf8",
);
const seq30 = fs.readFileSync(
  dir + "owner_activate_signed30_gateway_20261116.py",
  "utf8",
);

// Normalise every release-specific identifier so only structure is compared.
const normalise = (text) =>
  text
    .replace(
      /# Tools the CURRENT[\s\S]*?REQUIRED_OLD = frozenset\(\[[\s\S]*?\]\)\n/,
      "",
    )
    .replace(/REQUIRED = frozenset\(\[[\s\S]*?\]\)\n/, "REQUIRED = SET\n")
    .replace(
      "origin_probe(origin,port,required=None)",
      "origin_probe(origin,port)",
    )
    .replace("    required=REQUIRED if required is None else required\n", "")
    .replace("required.issubset", "REQUIRED.issubset")
    .replace(/,REQUIRED_OLD\)/g, ")")
    .replace(
      /def safe_gateway_config_bytes[\s\S]*?\ndef gateway_port/,
      "def SAFECONFIG\ndef gateway_port",
    )
    .replace(/z+-kmj-signed\d+\.conf/g, "ZCONF")
    .replace(/SIGNED\d+/g, "SIGNEDN")
    .replace(/signed\d+/g, "signedN")
    .replace(/stable\d+/g, "stableN")
    .replace(/\b[0-9a-f]{40}\b/g, "FULLSHA")
    .replace(/0\.3\.2-[0-9a-f]{12}/g, "RELDIR");

test("seq30 gateway script is structurally identical to the seq29 script that went live", () => {
  assert.equal(normalise(seq30), normalise(seq29));
  assert.match(seq30, /GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER/);
});

test("seq30 rollback side is the live signed29 override, new side is signed30", () => {
  assert.match(seq30, /OLD_CONF = DIR \/ "zzzzzzzzzzz-kmj-signed29\.conf"/);
  assert.match(
    seq30,
    /PREVIOUS_SHA = "e8c353dc839a01a8418e01e7b9209d46bcedc779"/,
  );
  assert.match(seq30, /0\.3\.2-e8c353dc839a"\)\nNEW_DIR/);
  assert.match(seq30, /NEW_CONF = DIR \/ "zzzzzzzzzzzz-kmj-signed30\.conf"/);
  assert.match(seq30, /NEW_SHA = "597037b07cac08729290d549c023111d1ab7e7c0"/);
  assert.match(seq30, /0\.3\.2-e8c353dc839a"\)/);
  assert.match(seq30, /SIGNED29_OVERRIDE_DRIFT/);
  assert.doesNotMatch(
    seq30,
    /signed27|SIGNED27|40655678|signed25|SIGNED25|signed28|SIGNED28/,
  );
});

test("seq30 identities match the owner-signed manifest merged on main", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      "releases/stable/597037b07cac08729290d549c023111d1ab7e7c0/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(manifest.sequence, 30);
  assert.equal(manifest.revision, seq30.match(/NEW_SHA = "([0-9a-f]{40})"/)[1]);
  assert.equal(
    "0.3.2-" + manifest.revision.slice(0, 12),
    seq30.match(
      /NEW_DIR = pathlib\.Path\("[^"]*\/(0\.3\.2-[0-9a-f]{12})"\)/,
    )[1],
  );
  const live = JSON.parse(
    fs.readFileSync(
      "releases/stable/e8c353dc839a01a8418e01e7b9209d46bcedc779/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(live.sequence, 29);
  assert.equal(
    live.revision,
    seq30.match(/PREVIOUS_SHA = "([0-9a-f]{40})"/)[1],
  );
});

test("seq30 override sorts after every live drop-in and is dry-run by default", () => {
  const live = [
    "90-github-readonly.conf",
    "99-kmj-pinned-runtime.conf",
    "zzzz-kmj-signed14.conf",
    "zzzzz-kmj-source-commit.conf",
    "zzzzzzzzz-kmj-signed25.conf",
    "zzzzzzzzzz-kmj-signed27.conf",
    "zzzzzzzzzzz-kmj-signed29.conf",
  ];
  const next = "zzzzzzzzzzzz-kmj-signed30.conf";
  assert.deepEqual([...live, next].sort().at(-1), next);
  assert.match(seq30, /SIGNED30_GATEWAY=DRY_RUN_UNCHANGED/);
  assert.match(seq30, /--confirm-no-active-jobs/);
});

test("seq30 adds no MCP tools over seq29, so it still requires the seq29 tool set and never edits config, updater or agent", () => {
  for (const tool of [
    "freellmapi_status",
    "freellmapi_generate",
    "worktree_lane_diagnose",
    "model_route_plan",
  ]) {
    assert.match(
      fs.readFileSync("src/tools.js", "utf8"),
      new RegExp(`"${tool}"`),
    );
  }
  assert.doesNotMatch(seq30, /chown|os\.chmod\(|stable-update\.json/);
});

test("seq30 accepts exactly the config layouts the gateway runtime accepts (src/config-file-mode.js)", () => {
  const runtime = fs.readFileSync("src/config-file-mode.js", "utf8");
  assert.match(runtime, /\(stat\.mode & 0o137\) === 0/);
  assert.match(runtime, /stat\.uid === 0/);
  assert.match(seq30, /\(st\.st_mode & 0o137\) == 0/);
  assert.match(seq30, /st\.st_uid == 0 and st\.st_gid == gid/);
  assert.match(seq30, /\(st\.st_mode & 0o077\) == 0 and st\.st_uid == uid/);
  assert.match(seq30, /grp\.getgrnam\("kmjcode"\)/);
  assert.match(seq30, /GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER/);
});

test("seq30 baseline, rollback and cutover probes all require exactly the tool set the live signed29 gateway exposes", () => {
  const old = seq30.match(/REQUIRED_OLD = frozenset\(\[([\s\S]*?)\]\)/)[1];
  const neu = seq30.match(/\nREQUIRED = frozenset\(\[([\s\S]*?)\]\)/)[1];
  const names = (x) => [...x.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const seq29Set = names(
    seq29.match(/\nREQUIRED = frozenset\(\[([\s\S]*?)\]\)/)[1],
  );
  assert.deepEqual(names(old).sort(), seq29Set.sort());
  assert.deepEqual(names(neu).sort(), seq29Set.sort());
  assert.match(seq30, /old=origin_probe\("DIRECT",port,REQUIRED_OLD\)/);
  assert.match(seq30, /observed=origin_probe\("DIRECT",port,REQUIRED_OLD\)/);
  assert.match(seq30, /seen=origin_probe\(origin,port\)/);
  assert.match(seq30, /seen=origin_probe\("PUBLIC",port\)/);
});
