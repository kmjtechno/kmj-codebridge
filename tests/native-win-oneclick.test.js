import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const setup = fs.readFileSync(
  "scripts/windows/ONE-CLICK-P720-SUPERVISOR.ps1",
  "utf8",
);
const recovery = fs.readFileSync(
  "scripts/windows/RECOVER-P720-SUPERVISOR.ps1",
  "utf8",
);
const bootstrap = fs.readFileSync(
  "scripts/windows/bootstrap-p720-supervisor.ps1",
  "utf8",
);
const launcher = fs.readFileSync(
  "scripts/windows/ONE-CLICK-P720-SUPERVISOR.cmd",
  "utf8",
);

test("same trusted one-click launcher routes fresh and interrupted installs safely", () => {
  assert.match(launcher, /ONE-CLICK-P720-SUPERVISOR\.ps1/);
  assert.match(launcher, /-NoProfile -ExecutionPolicy RemoteSigned/);
  assert.match(launcher, /if errorlevel 1/);
  assert.doesNotMatch(launcher, /curl|wget|invoke-expression|iex|bitsadmin/i);
  assert.match(setup, /RECOVER-P720-SUPERVISOR\.ps1/);
  assert.match(setup, /IsInRole/);
  assert.match(setup, /if \(-not \$Apply\)/);
  assert.match(setup, /& \$recovery -Apply/);
  assert.match(recovery, /& \$bootstrap -Resume -Apply/);
  assert.match(recovery, /& \$bootstrap -Apply/);
});

test("one-click emits sanitized underlying blocker instead of silently masking it", () => {
  assert.match(setup, /KMJ_NATIVE_SUPERVISOR_BLOCKER=\$code/);
  assert.match(setup, /UNCLASSIFIED_SETUP_FAILURE/);
  assert.match(setup, /KMJ_NATIVE_SUPERVISOR_RECOVERY_BLOCKED/);
  assert.doesNotMatch(setup, /\$_\.ToString|\$_\.ScriptStackTrace/);
  assert.match(setup, /AGENT_HANDOFF=PENDING_SEPARATE_VERIFIED_STEP/);
  assert.match(setup, /CINECORE=UNTOUCHED/);
  assert.doesNotMatch(
    setup,
    /git reset|Restart-Service|Unregister-ScheduledTask|Invoke-Expression/i,
  );
});

test("original installer running never looks like completed recovery or a self-process race", () => {
  for (const script of [recovery, bootstrap]) {
    assert.match(script, /\$_\.ProcessId -ne \$PID/);
  }
  assert.match(recovery, /RECOVERY_ORIGINAL_INSTALLER_STILL_RUNNING/);
  assert.match(recovery, /if \(\$Apply\) \{/);
  assert.match(recovery, /KMJ_RECOVERY_SUPERVISOR=VERIFIED/);
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
