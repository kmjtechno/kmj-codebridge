import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const install = fs.readFileSync(
  "scripts/windows/install-windows-supervisor.ps1",
  "utf8",
);
const rollback = fs.readFileSync(
  "scripts/windows/rollback-windows-supervisor.ps1",
  "utf8",
);

test("install script is dry-run by default and never activates the runtime", () => {
  assert.match(install, /\[switch\]\$Apply/);
  assert.match(install, /if \(-not \$Apply\)[\s\S]*return/);
  for (const forbidden of [
    /Start-ScheduledTask/i,
    /Start-Service/i,
    /Restart-Service/i,
    /Enable-ScheduledTask/i,
    /Invoke-Expression/i,
    /\biex\b/i,
    /-ExecutionPolicy\s+Bypass/i,
    /Set-Content\s+-LiteralPath\s+\$AgentConfig\b/,
  ])
    assert.doesNotMatch(install, forbidden, String(forbidden));
  assert.match(install, /Disable-ScheduledTask/);
  assert.match(install, /\.proposed/);
});

test("install script backs up with hashes and restricts the token ACL", () => {
  assert.match(install, /Get-FileHash -Algorithm SHA256/);
  assert.match(install, /manifest\.json/);
  assert.match(install, /icacls\.exe \$tokenFile \/inheritance:r/);
  assert.match(install, /Authenticated Users/);
});

test("rollback verifies the backup first and is dry-run by default", () => {
  assert.match(rollback, /\[switch\]\$Apply/);
  assert.ok(
    rollback.indexOf("Backup file changed or corrupt") <
      rollback.indexOf("Unregister-ScheduledTask"),
  );
  assert.match(rollback, /RestoreConfigs/);
  assert.doesNotMatch(rollback, /Remove-Item[^\n]*-Recurse/i);
  assert.doesNotMatch(rollback, /Start-ScheduledTask|Enable-ScheduledTask/i);
});

test("scripts are ASCII only so Windows PowerShell 5.1 parses them identically", () => {
  for (const text of [install, rollback]) assert.ok(!/[^\x00-\x7f]/.test(text));
});

test("installer refuses existing tasks, token ACL mutation, and stale agent proposals", () => {
  assert.match(install, /TASK_ALREADY_EXISTS/);
  assert.match(install, /TOKEN_ALREADY_EXISTS/);
  assert.match(install, /PROPOSED_AGENT_CONFIG_EXISTS/);
  assert.match(install, /AGENT_SUPERVISOR_ALREADY_CONFIGURED/);
  assert.match(install, /BACKUP_DESTINATION_EXISTS/);
  assert.doesNotMatch(install, /Register-ScheduledTask[^\n]*-Force/);
  assert.match(install, /taskName = \$TaskName/);
  assert.match(install, /tokenSha256 = \$null/);
  assert.match(install, /proposedSha256 = \$null/);
});

test("rollback refuses foreign tasks or changed installer-owned secrets and config", () => {
  assert.match(rollback, /ROLLBACK_MANIFEST_TASK_MISMATCH/);
  assert.match(rollback, /ROLLBACK_TASK_IDENTITY_MISMATCH/);
  assert.match(rollback, /ROLLBACK_TOKEN_CHANGED/);
  assert.match(rollback, /ROLLBACK_PROPOSED_CONFIG_CHANGED/);
  assert.ok(
    rollback.indexOf("ROLLBACK_TASK_IDENTITY_MISMATCH") <
      rollback.indexOf("Unregister-ScheduledTask"),
  );
  assert.ok(
    rollback.indexOf("ROLLBACK_TOKEN_CHANGED") <
      rollback.indexOf("Unregister-ScheduledTask"),
  );
  assert.ok(
    rollback.indexOf("ROLLBACK_PROPOSED_CONFIG_CHANGED") <
      rollback.indexOf("Unregister-ScheduledTask"),
  );
});
