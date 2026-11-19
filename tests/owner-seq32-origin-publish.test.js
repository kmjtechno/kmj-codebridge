import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const REV = "8c48ec92cc0720890efc8b8abf2b575395536e53";
const script = fs.readFileSync(
  "scripts/production/owner_publish_seq32_static_origin_20261119.py",
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
    "scripts/production/owner_publish_seq32_static_origin_20261119.py",
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
    "9ceec2f1a4bbdfc15adfe181236ab958fb786db17eef47ec4f8c457323f8d115",
  );
  assert.equal(
    sha(sig),
    "51318f77a36999fb2bedb4f399e10b7841d42bbddaaddabddf995561283ab633",
  );
  assert.equal(manifest.length, 512);
  assert.equal(sig.length, 87);
  assert.ok(script.includes(sha(manifest)));
  assert.ok(script.includes(sha(sig)));
  const data = JSON.parse(manifest);
  assert.ok(script.includes(data.sha256));
  assert.ok(script.includes(String(data.bytes)));
  assert.ok(script.includes(`REV = "${data.revision}"`));
  assert.equal(data.sequence, 32);
  assert.equal(
    data.archive,
    `https://kmjtechno.com/codebridge/releases/stable/${REV}/${script.match(/ARCHIVE = "([^"]+)"/)[1]}`,
  );
});

test("the owner script pins the signed values; publishing uses the generic manifest-verified workflow", () => {
  const wf = fs.readFileSync(
    ".github/workflows/publish-signed-stable.yml",
    "utf8",
  );
  assert.match(wf, /RELEASE_ONLY_EXACT_MANIFEST_AND_SIGNATURE/);
  for (const value of [
    "9ceec2f1a4bbdfc15adfe181236ab958fb786db17eef47ec4f8c457323f8d115",
    "9c9d4e9885745db86d47fa9adf4b79035f5de34c0df26006cc49f450f26010e9",
    "2432187",
  ]) {
    assert.ok(script.includes(value), value);
  }
});

test("rollback authority is the live seq31 release and the source is a main commit that carries the metadata", () => {
  const live = JSON.parse(
    fs.readFileSync(
      "releases/stable/c0505b74bf1b79df35f36fe0634f269bacf07f41/release-manifest.json",
      "utf8",
    ),
  );
  assert.equal(live.sequence, 31);
  assert.match(script, new RegExp(`PREVIOUS = "${live.revision}"`));
  assert.match(script, /info\.get\("sequence"\) == 31/);
  assert.match(script, /SOURCE = "0f5c85df99b2c77fbcf4adcb0efe37265e89e426"/);
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
