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

test("config owner script executes eight real root-only behaviour tests in Linux CI", (t) => {
  // Windows has no pwd/grp/chown. Linux CI must exercise actual fchown/fchmod
  // on an isolated /run fixture; zero executed tests is never a green CI gate.
  if (process.platform !== "linux") return t.skip("Linux-only owner test");
  const python = "/usr/bin/python3";
  assert.ok(fs.existsSync(python), "Linux CI needs pinned system Python");
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot && !process.env.CI) {
    return t.skip("root-only fixture; executed in Linux CI via noninteractive sudo");
  }

  const args = ["-I", "-B", "tests/test_owner_config_root_group_20261115.py"];
  const result = isRoot
    ? spawnSync(python, args, { encoding: "utf8" })
    : spawnSync("sudo", ["-n", python, ...args], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /Ran 8 tests/);
  assert.equal(result.stderr.includes("skipped="), false, "root tests were skipped");
});
