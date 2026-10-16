import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const bootstrap = fs.readFileSync(
  "scripts/windows/bootstrap-p720-supervisor.ps1",
  "utf8",
);
const recovery = fs.readFileSync(
  "scripts/windows/RECOVER-P720-SUPERVISOR.ps1",
  "utf8",
);
const launcher = fs.readFileSync(
  "scripts/windows/RECOVER-P720-SUPERVISOR.cmd",
  "utf8",
);

test("recovery refuses to race the original installer or overwrite partial registration", () => {
  assert.match(recovery, /EXISTING_INSTALLER_STILL_RUNNING/);
  assert.match(recovery, /DO_NOT_START_SECOND_INSTALLER/);
  assert.match(recovery, /RECOVERY_AMBIGUOUS_BACKUPS/);
  assert.match(recovery, /RECOVERY_TASK_WITHOUT_UNIQUE_BACKUP/);
  assert.match(recovery, /RECOVERY_PARTIAL_REGISTRATION/);
  assert.match(recovery, /RECOVERY_EXISTING_RELEASE_NOT_GIT/);
  assert.match(recovery, /Get-CimInstance Win32_Process/);
  assert.match(recovery, /-TaskPath '\\/);
  assert.doesNotMatch(
    recovery,
    /git reset|git clean|Remove-Item|Unregister-ScheduledTask|Stop-ScheduledTask|Restart-Service/i,
  );
});

test("resume validates SHA, origin, clean stage and empty checkout before any checkout", () => {
  assert.match(bootstrap, /\[switch\]\$Resume/);
  assert.match(bootstrap, /RESUME_ORIGINAL_INSTALLER_PROCESS_STILL_ACTIVE/);
  assert.match(bootstrap, /RESUME_HEAD_UNREADABLE/);
  assert.match(bootstrap, /RESUME_CHECKOUT_IS_NOT_EMPTY/);
  assert.match(bootstrap, /RESUME_EXPECTED_COMMIT_MISSING/);
  assert.match(bootstrap, /checkout --detach \$ExpectedSha/);
  assert.match(bootstrap, /PINNED_SHA_MISMATCH/);
  assert.match(bootstrap, /UNTRUSTED_RUNTIME_ORIGIN/);
  assert.match(bootstrap, /RESUME_RELEASE_NOT_CLEAN/);
  assert.match(bootstrap, /--ignore-scripts/);
  assert.doesNotMatch(bootstrap, /git reset|git clean|git checkout -f|Remove-Item/i);
});

test("recovery only starts the guarded activation after an eligible state", () => {
  assert.match(recovery, /if \(-not \$Apply\) \{ return \}/);
  assert.match(recovery, /-Resume -Apply/);
  assert.match(recovery, /RECOVERY_STATE=PREPARED_DISABLED/);
  assert.match(recovery, /& \$activation -Apply/);
  assert.match(recovery, /KMJ_RECOVERY_AGENT_HANDOFF=PENDING/);
  assert.match(launcher, /RECOVER-P720-SUPERVISOR\.ps1/);
  assert.match(launcher, /if errorlevel 1/);
  assert.doesNotMatch(launcher, /Invoke-Expression|curl|wget|powershell.*-enc/i);
});

test(
  "real Windows PowerShell accepts the recovery and resume script syntax",
  { skip: process.platform !== "win32" },
  () => {
    const code = [
      "$ErrorActionPreference='Stop';",
      "foreach ($f in @(",
      "'scripts/windows/bootstrap-p720-supervisor.ps1',",
      "'scripts/windows/RECOVER-P720-SUPERVISOR.ps1')) {",
      "$tok=$null; $errors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "$f,[ref]$tok,[ref]$errors) | Out-Null;",
      "if($errors.Count -gt 0){throw ($f+':'+$errors[0].Message)}",
      "}",
    ].join(" ");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", code], {
      timeout: 20000,
      stdio: "pipe",
    });
  },
);
