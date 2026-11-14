import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "scripts/production/";
const v1 = fs.readFileSync(
  dir + "owner_activate_signed25_gateway_20261114.py",
  "utf8",
);
const v2 = fs.readFileSync(
  dir + "owner_activate_signed25_gateway_v2_20261114.py",
  "utf8",
);
const cli = fs.readFileSync("src/cli.js", "utf8");

test("v2 only adds the startable-config preflight to the reviewed seq25 script", () => {
  const added = v2.split("\n").filter((line) => !v1.split("\n").includes(line));
  const removed = v1
    .split("\n")
    .filter((line) => !v2.split("\n").includes(line));
  assert.deepEqual(removed, []);
  assert.equal(added.length, 7);
  assert.equal(v2.length - v1.length, added.join("\n").length + 1);
  assert.match(
    v2,
    /need\(\(st\.st_mode & 0o077\) == 0 and st\.st_uid == uid,\n\s+"GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER"\)/,
  );
});

test("the preflight rule is the one the gateway runtime enforces at startup", () => {
  // src/cli.js rejects any group/other permission bit on the config file.
  assert.match(cli, /stat\.mode & 0o077\)\s*\n?\s*throw Error\(/);
  // The check runs while reading the config, before any systemd change.
  const check = v2.indexOf("GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER");
  const firstMutation = v2.indexOf("write_new(data);created=True");
  assert.ok(check > 0 && firstMutation > check);
  assert.match(
    v2,
    /port=gateway_port\(config\)\n\s+old=origin_probe\("DIRECT",port\)/,
  );
});
