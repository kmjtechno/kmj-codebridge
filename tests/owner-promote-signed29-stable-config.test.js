import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const REV = "e8c353dc839a01a8418e01e7b9209d46bcedc779";
const file =
  "scripts/production/owner_promote_signed29_stable_config_20261116.py";
const script = fs.readFileSync(file, "utf8");
const manifestPath = `releases/stable/${REV}/release-manifest.json`;

test("script is valid Python and is a dry run unless --apply is given", () => {
  const result = spawnSync("python3", [
    "-I",
    "-B",
    "-c",
    "import ast,sys;ast.parse(open(sys.argv[1]).read())",
    file,
  ]);
  assert.equal(result.status, 0);
  assert.match(script, /sys\.argv\[1:\] in \(\[\],\["--apply"\]\)/);
  assert.match(script, /CONFIG_PROMOTION=DRY_RUN_UNCHANGED/);
});

test("pins equal the owner-signed seq29 manifest merged on main", () => {
  const raw = fs.readFileSync(manifestPath);
  const data = JSON.parse(raw);
  assert.equal(data.sequence, 29);
  assert.ok(script.includes(`NEW = "${data.revision}"`));
  assert.ok(script.includes(data.sha256));
  assert.ok(script.includes(`ARCHIVE_SIZE = ${data.bytes}`));
  assert.ok(
    script.includes(
      "0c0b738fb59fd156bcd43813653e83520abff267f8369ed90251a3367dfa2752",
    ),
  );
  assert.ok(script.includes(`"${data.archive.split("/").pop()}"`));
  assert.match(script, /item\.get\("sequence"\)==29/);
});

test("only signed28 or signed27 may be promoted from; everything else is drift", () => {
  assert.match(
    script,
    /OLDS = \("f2a18a1feb0aa9df8b888ae363e4cc96b769c83b", "40655678db7fa62edca28ccc4988614010253ef1"\)/,
  );
  assert.match(script, /UPDATE_CONFIG_URL_DRIFT/);
  assert.doesNotMatch(script, /55a3f976/);
});

test("only manifestUrl and signatureUrl change, with a private no-overwrite backup and no activation", () => {
  assert.match(script, /CONFIG_FIELD_DRIFT/);
  assert.match(script, /stable-update\.before-signed29\.json/);
  assert.match(script, /EXISTING_BACKUP_REQUIRES_REVIEW/);
  assert.match(script, /O_EXCL/);
  assert.match(script, /STABLE_UPDATER=NOT_TRIGGERED/);
  assert.match(script, /GATEWAY_SWITCH=NOT_ATTEMPTED/);
  assert.doesNotMatch(script, /systemctl["'], *["'](start|restart|stop)/);
  assert.doesNotMatch(script, /SIGNED27/);
});
