import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const REV = "597037b07cac08729290d549c023111d1ab7e7c0";
const script = fs.readFileSync(
  "scripts/production/owner_publish_seq30_static_origin_20261116.py",
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
    "scripts/production/owner_publish_seq30_static_origin_20261116.py",
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
    "67048f5ee2c5fd4d3d3c499aca972f3155ba5ecd61eec372c7758dfe23b2f4c4",
  );
  assert.equal(
    sha(sig),
    "99f42c495ddcd2bd6f9db47bda576edd22c9ca96d4a34a6ea9688e8a9e62fdab",
  );
  assert.equal(manifest.length, 512);
  assert.equal(sig.length, 87);
  assert.ok(script.includes(sha(manifest)));
  assert.ok(script.includes(sha(sig)));
  const data = JSON.parse(manifest);
  assert.ok(script.includes(data.sha256));
  assert.ok(script.includes(String(data.bytes)));
  assert.ok(script.includes(`REV = "${data.revision}"`));
  assert.equal(data.sequence, 30);
  assert.equal(
    data.archive,
    `https://kmjtechno.com/codebridge/releases/stable/${REV}/${script.match(/ARCHIVE = "([^"]+)"/)[1]}`,
  );
});

test("the publish workflow pins exactly the same values as the owner script", () => {
  const wf = fs.readFileSync(
    ".github/workflows/publish-signed-stable30.yml",
    "utf8",
  );
  for (const value of [
    "67048f5ee2c5fd4d3d3c499aca972f3155ba5ecd61eec372c7758dfe23b2f4c4",
    "e9fc544406855c1902b207f9d27f05a1012dd9b29065d4b5b1cf2ea9662e14b6",
    "2325974",
  ]) {
    assert.ok(wf.includes(value), value);
    assert.ok(script.includes(value), value);
  }
  assert.doesNotMatch(wf, /eb47eece|dc2d6000|2236496/);
});

test("rollback authority is the live seq29 release and the source is a main commit that carries the metadata", () => {
  const live = JSON.parse(
    fs.readFileSync(
      "releases/stable/e8c353dc839a01a8418e01e7b9209d46bcedc779/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(live.sequence, 29);
  assert.match(script, new RegExp(`PREVIOUS = "${live.revision}"`));
  assert.match(script, /info\.get\("sequence"\) == 29/);
  assert.match(script, /SOURCE = "d262a9a111d695216fdf7b616065febd9921c182"/);
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
