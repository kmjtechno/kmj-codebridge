import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const REV = "e8c353dc839a01a8418e01e7b9209d46bcedc779";
const script = fs.readFileSync(
  "scripts/production/owner_publish_seq29_static_origin_20261116.py",
  "utf8",
);
const dir = `releases/stable/${REV}/`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("script compiles and defaults to a dry run that writes nothing", () => {
  const result = spawnSync("python3", [
    "-I",
    "-B",
    "-c",
    `import ast,sys;ast.parse(open(sys.argv[1]).read())`,
    "scripts/production/owner_publish_seq29_static_origin_20261116.py",
  ]);
  assert.equal(result.status, 0);
  assert.match(script, /PUBLICATION=DRY_RUN_UNCHANGED/);
  assert.match(script, /sys\.argv\[1:\] in \(\[\], \["--apply"\]\)/);
  assert.match(script, /if sys\.argv\[1:\] != \["--apply"\]:/);
});

test("pinned hashes and sizes equal the signed files merged on main", () => {
  const manifest = fs.readFileSync(dir + "release-manifest.json");
  const sig = fs.readFileSync(dir + "release-manifest.sig");
  assert.equal(
    sha(manifest),
    "0c0b738fb59fd156bcd43813653e83520abff267f8369ed90251a3367dfa2752",
  );
  assert.equal(
    sha(sig),
    "4323ff7056ab65d0afbad59dc1671ddd3c05380bce98e83bff35e3ca925c90f3",
  );
  assert.equal(manifest.length, 512);
  assert.equal(sig.length, 87);
  assert.ok(script.includes(sha(manifest)));
  assert.ok(script.includes(sha(sig)));
  const data = JSON.parse(manifest);
  assert.ok(script.includes(data.sha256));
  assert.ok(script.includes(String(data.bytes)));
  assert.ok(script.includes(`REV = "${data.revision}"`));
  assert.equal(data.sequence, 29);
  assert.equal(
    data.archive,
    `https://kmjtechno.com/codebridge/releases/stable/${REV}/${script.match(/ARCHIVE = "([^"]+)"/)[1]}`,
  );
});

test("the publish workflow pins exactly the same values as the owner script", () => {
  const wf = fs.readFileSync(
    ".github/workflows/publish-signed-stable29.yml",
    "utf8",
  );
  for (const value of [
    "0c0b738fb59fd156bcd43813653e83520abff267f8369ed90251a3367dfa2752",
    "e1c7262504dc5a21cd89aab26506055238d25f3ccace40c32b5a0a19d4eac35b",
    "2283307",
  ]) {
    assert.ok(wf.includes(value), value);
    assert.ok(script.includes(value), value);
  }
  assert.doesNotMatch(wf, /eb47eece|dc2d6000|2236496/);
});

test("rollback authority is the live seq28 release and the source is a main commit that carries the metadata", () => {
  const live = JSON.parse(
    fs.readFileSync(
      "releases/stable/f2a18a1feb0aa9df8b888ae363e4cc96b769c83b/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(live.sequence, 28);
  assert.match(script, new RegExp(`PREVIOUS = "${live.revision}"`));
  assert.match(script, /info\.get\("sequence"\) == 28/);
  assert.match(script, /SOURCE = "98c69821aa1af570606522981241266dbf8e0bb2"/);
});

test("script only creates the immutable directory: no service, config, nginx or latest changes", () => {
  assert.doesNotMatch(
    script,
    /systemctl|nginx|rename|unlink|rmtree|shutil|os\.chown|stable\/latest|stable-update\.json["'], *os\.O_WRONLY/,
  );
  assert.match(
    script,
    /os\.O_WRONLY \| os\.O_CREAT \| os\.O_EXCL \| os\.O_NOFOLLOW/,
  );
  assert.match(script, /GATEWAY_SWITCH=NOT_ATTEMPTED/);
  assert.match(script, /UPDATER_CONFIG=UNCHANGED/);
  assert.match(script, /--proto", "=https"/);
});
