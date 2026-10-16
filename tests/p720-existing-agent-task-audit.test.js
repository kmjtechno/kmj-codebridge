import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const audit = fs.readFileSync(
  "scripts/windows/AUDIT-P720-EXISTING-AGENT-TASK.ps1",
  "utf8",
);
const launcher = fs.readFileSync(
  "scripts/windows/AUDIT-P720-EXISTING-AGENT-TASK.cmd",
  "utf8",
);

test("existing agent-task audit contains no mutation command invocation", () => {
  assert.match(audit, /KMJ_AGENT_TASK_AUDIT_MODE=READ_ONLY/);
  assert.match(audit, /KMJ_AGENT_TASK_AUDIT_WRITES=NONE/);
  assert.match(audit, /Get-ScheduledTask -TaskName \$TaskName -TaskPath/);
  assert.match(audit, /Get-CimInstance Win32_Process/);
  assert.match(audit, /--no-optional-locks/);
  assert.doesNotMatch(
    audit,
    /^\s*(?:Start-Process|Stop-Process|Start-ScheduledTask|Stop-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask|Set-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Set-Content|Out-File|Set-Acl|git reset|git clean)\b/im,
  );
  assert.doesNotMatch(launcher, /taskkill|schtasks|git\s+reset|git\s+clean/i);
  assert.match(launcher, /AUDIT-P720-EXISTING-AGENT-TASK\.ps1/);
});

test("unknown or foreign tasks never become reusable", () => {
  assert.match(audit, /KMJ_AGENT_TASK_ACTION=.*MISMATCH/);
  assert.match(audit, /KMJ_AGENT_TASK_PRINCIPAL=.*MISMATCH/);
  assert.match(audit, /KMJ_AGENT_TASK_RECOVERY_POLICY=.*MISMATCH/);
  assert.match(audit, /AGENT_TASK_AUDIT_AGENT_NOT_UNIQUE/);
  assert.match(audit, /AGENT_TASK_AUDIT_AGENT_CONFIG_MISMATCH/);
  assert.match(audit, /AGENT_TASK_AUDIT_PINNED_RELEASE_CHANGED/);
  assert.match(audit, /AGENT_TASK_AUDIT_TASK_MISSING/);
  assert.match(audit, /KMJ_AGENT_TASK_AUDIT=CONFLICT_NO_CHANGES/);
  assert.match(
    audit,
    /KMJ_AGENT_TASK_AUDIT=ALREADY_ENABLED_OR_RUNNING_REVIEW_REQUIRED/,
  );
  assert.match(audit, /KMJ_AGENT_TASK_AUDIT=REUSABLE_DISABLED/);
  assert.match(audit, /KMJ_AGENT_TASK_NEXT=GUARDED_TAKEOVER_NOT_YET_ACTIVE/);
  assert.match(audit, /if \(\$state -ne 'Disabled'\)/);
  assert.match(
    audit,
    /if \(-not \(\$principalValid -and \$actionValid -and \$policyValid\)\)/,
  );
});
test("principal mismatch diagnosis emits safe identity, logon and run-level classifications", () => {
  const diagnostic = fs.readFileSync(
    "scripts/windows/DIAGNOSE-P720-AGENT-TASK-PRINCIPAL.ps1",
    "utf8",
  );
  const launcher = fs.readFileSync(
    "scripts/windows/DIAGNOSE-P720-AGENT-TASK-PRINCIPAL.cmd",
    "utf8",
  );
  for (const marker of [
    "KMJ_PRINCIPAL_IDENTITY=",
    "KMJ_PRINCIPAL_LOGON=",
    "KMJ_PRINCIPAL_RUN_LEVEL=",
    "KMJ_PRINCIPAL_DIAG_RESULT=MISMATCH_NO_CHANGES",
    "KMJ_PRINCIPAL_DIAG_IDENTITIES=HIDDEN",
    "KMJ_PRINCIPAL_DIAG_WRITES=NONE",
  ]) {
    assert.ok(diagnostic.includes(marker));
  }
  assert.match(diagnostic, /SidOf \$ownerName/);
  assert.match(diagnostic, /SidOf \$taskAccount/);
  assert.match(diagnostic, /PRINCIPAL_DIAG_FOREIGN_TASK_ACTION/);
  assert.match(diagnostic, /PRINCIPAL_DIAG_AGENT_EXECUTABLE_MISMATCH/);
  assert.doesNotMatch(
    diagnostic,
    /^\s*(?:Set-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|Disable-ScheduledTask|Enable-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Stop-Process|Start-Process|Set-Content|Out-File)\b/im,
  );
  assert.doesNotMatch(
    diagnostic,
    /Write-Output[^\r\n]*(?:\$ownerName|\$ownerSid|\$taskAccount|\$taskSid|CommandLine)/,
  );
  assert.match(launcher, /DIAGNOSE-P720-AGENT-TASK-PRINCIPAL\.ps1/);
});
test(
  "native PowerShell 5.1 principal diagnosis accepts the source without executing it",
  { skip: process.platform !== "win32" },
  () => {
    const command = [
      "$tokens=$null;$errors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "'scripts/windows/DIAGNOSE-P720-AGENT-TASK-PRINCIPAL.ps1',",
      "[ref]$tokens,[ref]$errors) | Out-Null;",
      "if ($errors.Count -gt 0) { throw $errors[0].Message }",
    ].join(" ");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      timeout: 20000,
      stdio: "pipe",
    });
  },
);

test("process args, secrets and user identities are never displayed", () => {
  assert.match(audit, /KMJ_AGENT_TASK_AUDIT_COMMAND_LINES=HIDDEN/);
  assert.match(audit, /KMJ_AGENT_TASK_AUDIT_SECRETS=HIDDEN/);
  assert.doesNotMatch(audit, /Write-Output[^\r\n]*CommandLine/);
  assert.doesNotMatch(audit, /Write-Output[^\r\n]*ownerName/);
  assert.doesNotMatch(audit, /Write-Output[^\r\n]*ownerSid/);
  assert.doesNotMatch(audit, /Write-Output[^\r\n]*ExpectedToken/);
});
test(
  "native PowerShell 5.1 audit parser accepts the source without executing it",
  { skip: process.platform !== "win32" },
  () => {
    const command = [
      "$tokens=$null;$errors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "'scripts/windows/AUDIT-P720-EXISTING-AGENT-TASK.ps1',",
      "[ref]$tokens,[ref]$errors) | Out-Null;",
      "if ($errors.Count -gt 0) { throw $errors[0].Message }",
    ].join(" ");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      timeout: 20000,
      stdio: "pipe",
    });
  },
);
