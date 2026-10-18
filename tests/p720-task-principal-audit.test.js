import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const audit = fs.readFileSync(
  "scripts/windows/AUDIT-P720-EXISTING-AGENT-TASK.ps1",
  "utf8",
);
const diag = fs.readFileSync(
  "scripts/windows/DIAGNOSE-P720-AGENT-TASK-PRINCIPAL.ps1",
  "utf8",
);

test("P720 full task audit resolves both identities to SID like the proven principal diagnostic", () => {
  for (const script of [audit, diag]) {
    assert.match(script, /function SidOf\(\[string\]\$Name\)/);
    assert.match(script, /Security\.Principal\.NTAccount/);
    assert.match(script, /Security\.Principal\.SecurityIdentifier/);
    assert.match(script, /\$ownerSid\s*=\s*SidOf\s+\$ownerName/);
    assert.match(script, /-ieq\s+\$taskSid|-ieq\s+\$principalSid/);
  }
  assert.match(audit, /\$principalSid\s*=\s*SidOf\s+\$principalName/);
  assert.match(audit, /\$ownerSid\s+-and\s+\$principalSid/);
  assert.doesNotMatch(audit, /\$ownerSid\s+-and\s+\$principalName\s+-ieq\s+\$ownerSid/);
});

test("P720 task audit keeps every fail-closed gate and never activates a task", () => {
  for (const marker of [
    "KMJ_AGENT_TASK_RELEASE=PINNED_CLEAN",
    "KMJ_AGENT_TASK_AGENT_CONFIG=SCOPED",
    "KMJ_AGENT_TASK_ACTIVE_AGENT_COUNT",
    "KMJ_AGENT_TASK_PRINCIPAL=",
    "KMJ_AGENT_TASK_ACTION=",
    "KMJ_AGENT_TASK_RECOVERY_POLICY=",
    "KMJ_AGENT_TASK_AUDIT=CONFLICT_NO_CHANGES",
    "KMJ_AGENT_TASK_AUDIT=REUSABLE_DISABLED",
    "KMJ_AGENT_TASK_NEXT=GUARDED_TAKEOVER_NOT_YET_ACTIVE",
    "KMJ_AGENT_TASK_AUDIT_WRITES=NONE",
  ])
    assert.ok(audit.includes(marker), marker);
  for (const forbidden of [
    /^\s*(?:Start|Stop|Enable|Disable|Register|Unregister|Set)-ScheduledTask\b/im,
    /^\s*(?:Stop-Process|Start-Process|Restart-Service|Set-Content|Remove-Item|Invoke-Expression)\b/im,
  ])
    assert.doesNotMatch(audit, forbidden);
  assert.ok(!/[^\x00-\x7f]/.test(audit), "Windows PowerShell 5.1 ASCII script");
});

test(
  "P720 SID resolver treats account name and SID as the same owner but rejects different SIDs",
  { skip: process.platform !== "win32" },
  () => {
    const fn = audit.match(/^function SidOf\(\[string\]\$Name\) \{[\s\S]*?^\}/m);
    assert.ok(fn, "audited SID conversion function");
    const powerShell = [
      "$ErrorActionPreference = 'Stop'",
      fn[0],
      "$me = [Security.Principal.WindowsIdentity]::GetCurrent()",
      "if ((SidOf $me.Name) -cne (SidOf $me.User.Value)) { throw 'SID_ALIAS_NOT_EQUAL' }",
      "if ((SidOf 'S-1-5-18') -ceq (SidOf 'S-1-5-19')) { throw 'FOREIGN_SID_ACCEPTED' }",
      "if ((SidOf '') -ne $null) { throw 'EMPTY_IDENTITY_ACCEPTED' }",
      "if ((SidOf 'KMJ_Unknown_Identity_NoSuchAccount') -ne $null) { throw 'UNKNOWN_IDENTITY_ACCEPTED' }",
      "Write-Output 'P720_SID_RESOLVER=PASS'",
    ].join("\n");
    const result = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", powerShell],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.match(result, /P720_SID_RESOLVER=PASS/);
  },
);
