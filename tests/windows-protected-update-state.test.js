import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/windows/INSTALL-SIGNED-UPDATE-STATE.ps1", import.meta.url),
);
const windowsOnly = { skip: process.platform !== "win32" };

function run(args) {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  return spawnSync(
    root + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-NonInteractive", "-File", script, ...args],
    { encoding: "utf8", timeout: 30000, windowsHide: true },
  );
}

test("Windows ACL admits admin and SYSTEM", windowsOnly, () => {
  const result = run(["-CheckAclContract"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WINDOWS_UPDATE_STATE_ACL_CONTRACT=PASS/);
  assert.doesNotMatch(result.stdout, /CREATED_PROTECTED/);
});

test("Windows setup requires owner approval", windowsOnly, () => {
  const result = run(["-Apply"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /WINDOWS_UPDATE_STATE_OWNER_CONFIRMATION_REQUIRED/,
  );
  assert.doesNotMatch(result.stdout, /CREATED_PROTECTED/);
});
