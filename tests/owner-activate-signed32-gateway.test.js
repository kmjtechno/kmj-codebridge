import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "scripts/production/";
const seq31 = fs.readFileSync(
  dir + "owner_activate_signed31_gateway_20261117.py",
  "utf8",
);
const seq32 = fs.readFileSync(
  dir + "owner_activate_signed32_gateway_20261119.py",
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

test("seq32 gateway script is structurally identical to the seq31 script that went live", () => {
  assert.equal(normalise(seq32), normalise(seq31));
  assert.match(seq32, /GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER/);
});

test("seq32 rollback side is the live signed31 override, new side is signed32", () => {
  assert.match(seq32, /OLD_CONF = DIR \/ "zzzzzzzzzzzzzz-kmj-signed31\.conf"/);
  assert.match(
    seq32,
    /PREVIOUS_SHA = "c0505b74bf1b79df35f36fe0634f269bacf07f41"/,
  );
  assert.match(seq32, /0\.3\.2-c0505b74bf1b"\)\nNEW_DIR/);
  assert.match(seq32, /NEW_CONF = DIR \/ "zzzzzzzzzzzzzzz-kmj-signed32\.conf"/);
  assert.match(seq32, /NEW_SHA = "8c48ec92cc0720890efc8b8abf2b575395536e53"/);
  assert.match(seq32, /0\.3\.2-c0505b74bf1b"\)/);
  assert.match(seq32, /SIGNED31_OVERRIDE_DRIFT/);
  assert.doesNotMatch(
    seq32,
    /signed27|SIGNED27|40655678|signed25|SIGNED25|signed28|SIGNED28|signed29|SIGNED29/,
  );
});

test("seq32 identities match the owner-signed manifest merged on main", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      "releases/stable/8c48ec92cc0720890efc8b8abf2b575395536e53/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(manifest.sequence, 32);
  assert.equal(manifest.revision, seq32.match(/NEW_SHA = "([0-9a-f]{40})"/)[1]);
  assert.equal(
    "0.3.2-" + manifest.revision.slice(0, 12),
    seq32.match(
      /NEW_DIR = pathlib\.Path\("[^"]*\/(0\.3\.2-[0-9a-f]{12})"\)/,
    )[1],
  );
  const live = JSON.parse(
    fs.readFileSync(
      "releases/stable/c0505b74bf1b79df35f36fe0634f269bacf07f41/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(live.sequence, 31);
  assert.equal(
    live.revision,
    seq32.match(/PREVIOUS_SHA = "([0-9a-f]{40})"/)[1],
  );
});

test("seq32 override sorts after every live drop-in and is dry-run by default", () => {
  const live = [
    "90-github-readonly.conf",
    "99-kmj-pinned-runtime.conf",
    "zzzz-kmj-signed14.conf",
    "zzzzz-kmj-source-commit.conf",
    "zzzzzzzzz-kmj-signed25.conf",
    "zzzzzzzzzz-kmj-signed27.conf",
    "zzzzzzzzzzz-kmj-signed28.conf",
    "zzzzzzzzzzzzzz-kmj-signed31.conf",
  ];
  const next = "zzzzzzzzzzzzzzz-kmj-signed32.conf";
  assert.deepEqual([...live, next].sort().at(-1), next);
  // The rollback override must be named exactly like the file live on KMJ-elite.
  const old = seq32.match(/OLD_CONF = DIR \/ "([^"]+)"/)[1];
  assert.ok(live.includes(old), old);
  assert.equal(next, seq32.match(/NEW_CONF = DIR \/ "([^"]+)"/)[1]);
  assert.match(seq32, /SIGNED32_GATEWAY=DRY_RUN_UNCHANGED/);
  assert.match(seq32, /--confirm-no-active-jobs/);
});

test("seq32 adds no MCP tools over seq31, so it still requires the seq31 tool set and never edits config, updater or agent", () => {
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
  assert.doesNotMatch(seq32, /chown|os\.chmod\(|stable-update\.json/);
});

test("seq32 accepts exactly the config layouts the gateway runtime accepts (src/config-file-mode.js)", () => {
  const runtime = fs.readFileSync("src/config-file-mode.js", "utf8");
  assert.match(runtime, /\(stat\.mode & 0o137\) === 0/);
  assert.match(runtime, /stat\.uid === 0/);
  assert.match(seq32, /\(st\.st_mode & 0o137\) == 0/);
  assert.match(seq32, /st\.st_uid == 0 and st\.st_gid == gid/);
  assert.match(seq32, /\(st\.st_mode & 0o077\) == 0 and st\.st_uid == uid/);
  assert.match(seq32, /grp\.getgrnam\("kmjcode"\)/);
  assert.match(seq32, /GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER/);
});

test("seq32 baseline, rollback and cutover probes all require exactly the tool set the live signed31 gateway exposes", () => {
  const old = seq32.match(/REQUIRED_OLD = frozenset\(\[([\s\S]*?)\]\)/)[1];
  const neu = seq32.match(/\nREQUIRED = frozenset\(\[([\s\S]*?)\]\)/)[1];
  const names = (x) => [...x.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const seq31Set = names(
    seq31.match(/\nREQUIRED = frozenset\(\[([\s\S]*?)\]\)/)[1],
  );
  assert.deepEqual(names(old).sort(), seq31Set.sort());
  assert.deepEqual(names(neu).sort(), seq31Set.sort());
  assert.match(seq32, /old=origin_probe\("DIRECT",port,REQUIRED_OLD\)/);
  assert.match(seq32, /observed=origin_probe\("DIRECT",port,REQUIRED_OLD\)/);
  assert.match(seq32, /seen=origin_probe\(origin,port\)/);
  assert.match(seq32, /seen=origin_probe\("PUBLIC",port\)/);
});
