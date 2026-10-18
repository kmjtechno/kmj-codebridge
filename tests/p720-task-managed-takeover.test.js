import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const name = "scripts/windows/VERIFY-P720-TASK-TAKEOVER-READONLY.ps1";
const script = fs.readFileSync(name, "utf8");

test("P720 takeover preflight is read-only with no alternate activation mode", () => {
  assert.match(script, /param\(\[switch\]\$SelfTest\)/);
  assert.doesNotMatch(script, /\[switch\]\$Apply\b/);
  for (const forbidden of [
    /\b(?:Start|Stop|Enable|Disable|Register|Unregister|Set)-ScheduledTask\b/i,
    /\b(?:Start-Process|Stop-Process|Restart-Service|Set-Content|Add-Content|Out-File|Remove-Item|Copy-Item|Move-Item|Set-Acl|New-Item)\b/i,
    /\b(?:Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|iex)\b/i,
    /\[IO\.File\]::(?:WriteAllText|WriteAllBytes|Replace|Move)\b/i,
  ])
    assert.doesNotMatch(script, forbidden, String(forbidden));
  assert.match(script, /KMJ_TASK_TAKEOVER_WRITES=NONE/);
  assert.match(script, /KMJ_TASK_TAKEOVER_ACTIVATED=NO/);
  assert.match(script, /KMJ_TASK_TAKEOVER_READY=NO/);
  assert.doesNotMatch(script, /KMJ_TASK_TAKEOVER_READY=YES/);
  assert.ok(!/[^\x00-\x7f]/.test(script), "PowerShell 5.1 ASCII text");
});

test("P720 takeover readiness enforces task, agent and journal integrity", () => {
  for (const part of [
    "TAKEOVER_ADMIN_REQUIRED",
    "TAKEOVER_RELEASE_SHA_CHANGED",
    "TAKEOVER_RELEASE_DIRTY",
    "TAKEOVER_CONFIG_SCOPE_MISMATCH",
    "TAKEOVER_AGENT_NOT_UNIQUE",
    "TAKEOVER_PROCESS_VISIBILITY_INCOMPLETE",
    "TAKEOVER_AGENT_LOCK_MISMATCH",
    "TAKEOVER_TASK_NOT_DISABLED_EXACT",
    "TAKEOVER_TASK_ACTION_MISMATCH",
    "TAKEOVER_PRINCIPAL_SID_MISMATCH",
    "TAKEOVER_PRINCIPAL_POLICY_CHANGED",
    "TAKEOVER_RECOVERY_POLICY_CHANGED",
    "TAKEOVER_SUPERVISOR_TASK_NOT_RUNNING",
    "TAKEOVER_JOB_ACTIVE",
    "TAKEOVER_AUTOPILOT_ACTIVE",
    "KMJ_TASK_TAKEOVER_CANARY=S4U_NETWORK_SESSION_UNVERIFIED",
    "KMJ_TASK_TAKEOVER_HEARTBEAT=TASK_CONTEXT_NOT_PROVEN",
    "KMJ_TASK_TAKEOVER_ROLLBACK=NOT_EXECUTED",
  ])
    assert.ok(script.includes(part), part);
  assert.match(script, /\$taskSid\s*=\s*SidOf/);
  assert.match(script, /\$ownerSid\s*=\s*SidOf/);
  assert.match(script, /KMJ_TASK_TAKEOVER_READY=NO'\s*\n\s*exit 3/);
  assert.match(script, /KMJ_TASK_TAKEOVER_READY=NO'\s*\n\s*exit 2/);
  assert.doesNotMatch(
    script,
    /Write-Output.*(?:\.CommandLine|supervisor\.token|\.UserId)/i,
  );
});

test(
  "Windows PowerShell parses the P720 preflight and SID self-test fails closed",
  { skip: process.platform !== "win32" },
  () => {
    const syntaxCommand =
      "$t=$null;$e=$null;" +
      "[System.Management.Automation.Language.Parser]::ParseFile('" +
      name.replace(/\//g, "\\") +
      "',[ref]$t,[ref]$e)|Out-Null;" +
      "if($e.Count -gt 0){exit 8};Write-Output 'POWERSHELL_AST=PASS'";
    const syntax = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", syntaxCommand],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.match(syntax, /POWERSHELL_AST=PASS/);
    const result = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", name, "-SelfTest"],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.match(result, /KMJ_TASK_TAKEOVER_SID_SELFTEST=PASS/);
    assert.match(result, /KMJ_TASK_TAKEOVER_NOT_ACTIVATED=YES/);
  },
);
