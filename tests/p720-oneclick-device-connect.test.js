import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const psFile = path.resolve("scripts/windows/CONNECT-P720-CODEBRIDGE.ps1");
const cmdFile = path.resolve("scripts/windows/CONNECT-P720-CODEBRIDGE.cmd");
const ps = fs.readFileSync(psFile, "utf8");
const cmd = fs.readFileSync(cmdFile, "utf8");

test("double-click connector keeps the approved device, fixed SHA and private state", () => {
  assert.match(cmd, /%~dp0CONNECT-P720-CODEBRIDGE\.ps1/);
  assert.match(cmd, /-NoProfile -ExecutionPolicy RemoteSigned -File/);
  assert.match(ps, /5334ebf83a4d2eac8135f6a4eb84a5f2d61f4674/);
  assert.match(ps, /private\\p720-codebridge\\agent\.json/);
  assert.match(ps, /codebridge-releases\\\$sourceSha/);
  assert.match(ps, /ApprovedScope \$cfg/);
  assert.match(ps, /ENROLLMENT_SCOPE_MISMATCH/);
  assert.match(ps, /UNTRUSTED_SOURCE_REMOTE/);
  assert.match(ps, /PINNED_RELEASE_TRACKED_CHANGES/);
  assert.match(ps, /PINNED_RUNTIME_DEPENDENCIES_MISSING/);
  assert.match(ps, /-notmatch '\^\.\{32,8192\}\$'/);
});

test("connector never takes over or duplicates an existing enrolled agent", () => {
  assert.match(ps, /DUPLICATE_ENROLLED_AGENTS/);
  assert.match(ps, /AGENT_LOCK_OWNER_MISMATCH/);
  assert.match(ps, /AGENT_LOCK_OWNER_ALIVE/);
  assert.match(ps, /DEVICE_CONNECT=ALREADY_RUNNING/);
  assert.match(ps, /DUPLICATE_AGENT_STARTED=NO/);
  assert.match(ps, /SCOPED_AGENT_RACE_DETECTED/);
  assert.match(ps, /AGENT_EXITED_BEFORE_HEARTBEAT/);
  assert.doesNotMatch(
    ps,
    /\b(?:Stop-Process|Register-ScheduledTask|Start-ScheduledTask|New-LocalUser|Invoke-Expression|Set-Content)\b/,
  );
  assert.doesNotMatch(ps, /git(?:\.exe)?\b[^\n]*\b(?:reset|clean|pull|fetch|merge)\b/i);
  assert.doesNotMatch(cmd, /ExecutionPolicy Bypass|setx |schtasks \/create/i);
});

test("connector distinguishes anonymous reachability from device authorization", () => {
  assert.match(ps, /\/agent\/health/);
  assert.match(ps, /-MaximumRedirection 0/);
  assert.match(ps, /StatusCode -ne 401/);
  assert.match(ps, /FreshConnection \$started/);
  assert.match(ps, /LOCAL_AUTHENTICATED_HEARTBEAT/);
  assert.match(ps, /ACCOUNT_GRANT=VERIFY_IN_AUTHENTICATED_CODEBRIDGE_CLIENT/);
  assert.match(ps, /PAIRING_REQUIRED_USE_OWNER_APPROVED_PAIRING_LAUNCHER/);
  assert.match(ps, /if \(\$CheckOnly\)/);
  assert.match(ps, /DEVICE_CONNECT=DRY_RUN/);
  assert.match(ps, /ENROLLMENT=UNCHANGED/);
  assert.match(ps, /DIRTY_CHECKOUT=UNTOUCHED/);
  assert.doesNotMatch(ps, /GITHUB_TOKEN|gh auth token|OPENAI_API_KEY/);
});

test("Windows PowerShell parses and approves only known local scope", (t) => {
  if (process.platform !== "win32") {
    t.skip("Native PowerShell test runs in the Windows CI matrix");
    return;
  }
  const safe = psFile.replaceAll("'", "''");
  const command = [
    "$ErrorActionPreference='Stop'",
    "$tokens=$null;$errors=$null",
    "[System.Management.Automation.Language.Parser]::ParseFile('" +
      safe + "',[ref]$tokens,[ref]$errors) | Out-Null",
    "if($errors.Count -gt 0) { exit 2 }",
    "& '" + safe + "' -SelfTest",
    "if($LASTEXITCODE -ne 0) { exit 3 }",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /DEVICE_CONNECT_SELFTEST=PASS/);
});
