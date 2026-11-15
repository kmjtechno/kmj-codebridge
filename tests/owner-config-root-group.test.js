import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(
  "scripts/production/owner_config_root_group_20261115.py",
  "utf8",
);

test("config owner script is dry-run by default and needs an explicit confirm flag", () => {
  assert.match(source, /CONFIG_OWNER_CHANGE=DRY_RUN_UNCHANGED/);
  assert.match(source, /--confirm-root-group-config-owner-go/);
  assert.match(source, /argv in \(\[\], \["--apply", CONFIRM\]/);
});

test("config owner script only touches the two fixed paths and never restarts or prints config", () => {
  assert.match(source, /\/etc\/kmj-codebridge-stage\/?"/);
  assert.match(source, /GATEWAY_RESTART=NOT_PERFORMED/);
  assert.doesNotMatch(source, /systemctl["', ]+(restart|stop|start|reload)/);
  assert.doesNotMatch(source, /shell=True|os\.system|rm -rf|print\(.*read/);
  // Requires the signed28 runtime that accepts a root-owned group-readable config.
  assert.match(source, /RUNTIME_DOES_NOT_ACCEPT_ROOT_OWNED_CONFIG/);
});

test("config owner script behavioural tests pass (apply order, rollback, blocked states)", (t) => {
  const python = spawnSync("python3", ["--version"]);
  if (python.status !== 0) return t.skip("python3 unavailable");
  const result = spawnSync(
    "python3",
    ["-I", "-B", "tests/test_owner_config_root_group_20261115.py"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
