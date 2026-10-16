import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const setup = fs.readFileSync(
  "scripts/windows/ONE-CLICK-P720-SUPERVISOR.ps1",
  "utf8",
);
const launcher = fs.readFileSync(
  "scripts/windows/ONE-CLICK-P720-SUPERVISOR.cmd",
  "utf8",
);

test("operator one-click launcher uses only checked in own supervisor scripts", () => {
  assert.match(launcher, /ONE-CLICK-P720-SUPERVISOR\.ps1/);
  assert.match(launcher, /-NoProfile -ExecutionPolicy RemoteSigned/);
  assert.match(launcher, /if errorlevel 1/);
  assert.doesNotMatch(launcher, /curl|wget|invoke-expression|iex|bitsadmin/i);
  assert.match(setup, /bootstrap-p720-supervisor\.ps1/);
  assert.match(setup, /activate-p720-supervisor\.ps1/);
  assert.match(setup, /IsInRole/);
});

test("activation cannot start before successful preparation and honors explicit Apply", () => {
  assert.match(setup, /if \(-not \$Apply\)/);
  const prepare = setup.indexOf("& $prepare -Apply");
  const activate = setup.indexOf("& $activate -Apply");
  assert.ok(prepare > 0);
  assert.ok(activate > prepare);
  assert.match(setup, /KMJ_NATIVE_SUPERVISOR_PREPARE_BLOCKED/);
  assert.match(setup, /KMJ_NATIVE_SUPERVISOR_ACTIVATION_BLOCKED/);
  assert.match(setup, /AGENT_HANDOFF=PENDING_SEPARATE_VERIFIED_STEP/);
  assert.match(setup, /CINECORE=UNTOUCHED/);
  assert.doesNotMatch(
    setup,
    /git reset|Restart-Service|Unregister-ScheduledTask|Invoke-Expression/i,
  );
});

test(
  "one-click PowerShell parses on real Windows without executing installer",
  { skip: process.platform !== "win32" },
  () => {
    const code = [
      "$tok=$null; $errors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "'scripts/windows/ONE-CLICK-P720-SUPERVISOR.ps1',",
      "[ref]$tok,[ref]$errors) | Out-Null;",
      "if($errors.Count -gt 0) { throw $errors[0].Message }",
    ].join(" ");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", code], {
      timeout: 20000,
      stdio: "pipe",
    });
  },
);
