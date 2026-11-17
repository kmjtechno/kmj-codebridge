import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const REV = "c0505b74bf1b79df35f36fe0634f269bacf07f41";
const script = fs.readFileSync(
  "scripts/production/owner_publish_seq31_static_origin_20261117.py",
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
    "scripts/production/owner_publish_seq31_static_origin_20261117.py",
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
    "033796347bfcde1a24b6b2eef629d3bc2d00b5591c74c618c9a99fc4b0342990",
  );
  assert.equal(
    sha(sig),
    "49a8503782b7db11193d2e8fd738ed7c64a3e8e2e0c55b10ce3ba8e67bfdd431",
  );
  assert.equal(manifest.length, 512);
  assert.equal(sig.length, 87);
  assert.ok(script.includes(sha(manifest)));
  assert.ok(script.includes(sha(sig)));
  const data = JSON.parse(manifest);
  assert.ok(script.includes(data.sha256));
  assert.ok(script.includes(String(data.bytes)));
  assert.ok(script.includes(`REV = "${data.revision}"`));
  assert.equal(data.sequence, 31);
  assert.equal(
    data.archive,
    `https://kmjtechno.com/codebridge/releases/stable/${REV}/${script.match(/ARCHIVE = "([^"]+)"/)[1]}`,
  );
});

test("the publish workflow pins exactly the same values as the owner script", () => {
  const wf = fs.readFileSync(
    ".github/workflows/publish-signed-stable31.yml",
    "utf8",
  );
  for (const value of [
    "033796347bfcde1a24b6b2eef629d3bc2d00b5591c74c618c9a99fc4b0342990",
    "539f19da0838cb59d53b3b259929ab229146478412eaece2daf2283a96d4264b",
    "2368861",
  ]) {
    assert.ok(wf.includes(value), value);
    assert.ok(script.includes(value), value);
  }
  assert.doesNotMatch(wf, /eb47eece|dc2d6000|2236496/);
});

test("rollback authority is the live seq30 release and the source is a main commit that carries the metadata", () => {
  const live = JSON.parse(
    fs.readFileSync(
      "releases/stable/597037b07cac08729290d549c023111d1ab7e7c0/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(live.sequence, 30);
  assert.match(script, new RegExp(`PREVIOUS = "${live.revision}"`));
  assert.match(script, /info\.get\("sequence"\) == 30/);
  assert.match(script, /SOURCE = "b1663cefc35272430cfa9a834ce234c8e506e5e0"/);
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
