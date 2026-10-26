import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  publishMissingUnit,
  unitText,
  verifyUnitInventory,
} from "../scripts/recover-main-platform-refresh-unit.js";

const test = (name, fn) =>
  nodeTest(name, { skip: process.platform !== "linux" }, fn);

test("refuses effective vendor units and systemd drop-ins", () => {
  for (const inventory of [
    {
      LoadState: "loaded",
      FragmentPath: "/usr/lib/systemd/system/owner.service",
      DropInPaths: "",
    },
    {
      LoadState: "loaded",
      FragmentPath:
        "/etc/systemd/system/kmj-codebridge-main-platform-refresh.service",
      DropInPaths:
        "/run/systemd/system/kmj-codebridge-main-platform-refresh.service.d/override.conf",
    },
    { LoadState: "masked", FragmentPath: "/dev/null", DropInPaths: "" },
    {
      LoadState: "not-found",
      FragmentPath: "",
      DropInPaths: "",
      Extra: "unknown",
    },
  ])
    assert.throws(
      () => verifyUnitInventory(inventory),
      /EFFECTIVE_UNIT_CONFLICT/,
    );
  assert.doesNotThrow(() =>
    verifyUnitInventory({
      LoadState: "not-found",
      FragmentPath: "",
      DropInPaths: "",
    }),
  );
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-unit-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "refresh.service");
}
test("publishes only the fixed unit and reloads once without starting services", (t) => {
  const file = fixture(t),
    calls = [];
  assert.equal(
    publishMissingUnit(file, () => calls.push("reload")),
    "installed",
  );
  assert.equal(fs.readFileSync(file, "utf8"), unitText);
  assert.deepEqual(calls, ["reload"]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(
    publishMissingUnit(file, () => calls.push("reload")),
    "unchanged",
  );
  assert.deepEqual(calls, ["reload"]);
});
test("refuses existing configuration drift without touching it", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, "owner configuration");
  assert.throws(
    () => publishMissingUnit(file, () => assert.fail()),
    /EXISTING_UNIT_DRIFT/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "owner configuration");
});
test("rejects a symlink even when its target contains the expected unit", (t) => {
  const file = fixture(t),
    target = file + ".owner";
  fs.writeFileSync(target, unitText);
  fs.symlinkSync(target, file);
  assert.throws(() => publishMissingUnit(file, () => assert.fail()), /UNSAFE/);
  assert.equal(fs.readFileSync(target, "utf8"), unitText);
});
test("reload failure removes only its new unit and attempts rollback reload", (t) => {
  const file = fixture(t);
  let calls = 0;
  assert.throws(
    () =>
      publishMissingUnit(file, () => {
        calls++;
        throw Error("reload failed");
      }),
    /reload failed/,
  );
  assert.equal(fs.existsSync(file), false);
  assert.equal(calls, 2);
});
test("unit retains the established root refresh confinement", () => {
  assert.match(
    unitText,
    /ExecStart=\/bin\/bash \/opt\/kmj-codebridge-agent\/scripts\/refresh-main-platform-agent.sh/,
  );
  assert.match(unitText, /ProtectSystem=strict/);
  assert.match(unitText, /RestrictAddressFamilies=AF_UNIX/);
  assert.doesNotMatch(unitText, /sudo|\/bin\/sh -c|ExecStartPost/);
});
test("rejects hardlinked units and preserves both names", (t) => {
  const file = fixture(t),
    other = file + ".owner";
  fs.writeFileSync(other, unitText);
  fs.linkSync(other, file);
  assert.throws(() => publishMissingUnit(file, () => assert.fail()), /UNSAFE/);
  assert.equal(fs.statSync(file).nlink, 2);
});
test("rejects writable existing units without normalizing owner permissions", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, unitText);
  fs.chmodSync(file, 0o666);
  assert.throws(() => publishMissingUnit(file, () => assert.fail()), /UNSAFE/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o666);
});
test("CLI refuses caller paths and service arguments before preflight", () => {
  for (const args of [
    [],
    ["--install", "/tmp/override"],
    ["--service", "ssh"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/recover-main-platform-refresh-unit.js", ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BLOCKED_USE_CHECK_OR_INSTALL_ONLY/);
  }
});
