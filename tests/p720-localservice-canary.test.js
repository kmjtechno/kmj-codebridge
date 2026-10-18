import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";

const runnerName = "scripts/windows/RUN-P720-LOCALSERVICE-CANARY.ps1";
const canaryName = "scripts/windows/CANARY-P720-LOCALSERVICE.ps1";
const runner = fs.readFileSync(runnerName, "utf8");
const canary = fs.readFileSync(canaryName, "utf8");

test("P720 LocalService canary never starts an agent, exposes tokens or changes original task", () => {
  assert.match(runner, /param\(\[switch\]\$Apply\)/);
  assert.match(runner, /KMJ-CodeBridge-P720-LocalService-Canary/);
  assert.match(runner, /KMJ-CodeBridge-P720-Agent/);
  assert.match(runner, /CANARY_ORIGINAL_TASK_CHANGED/);
  assert.match(runner, /CANARY_AGENT_LOCK_CHANGED/);
  assert.match(runner, /KMJ_P720_LOCALSERVICE_CANARY_AGENT_MUTATIONS=NONE/);
  assert.match(runner, /KMJ_P720_LOCALSERVICE_CANARY_TAKEOVER=NOT_PERFORMED/);
  assert.match(canary, /KMJ_P720_SERVICE_CANARY_AGENT_STARTED=NO/);
  assert.match(canary, /KMJ_P720_SERVICE_CANARY_AUTHENTICATED_GATEWAY=UNPROVEN/);
  assert.match(canary, /KMJ_P720_SERVICE_CANARY_TAKEOVER=NOT_AUTHORIZED/);
  assert.doesNotMatch(canary, /\b(?:Start|Stop|Enable|Disable|Register|Unregister)-ScheduledTask\b/i);
  assert.doesNotMatch(canary, /\b(?:Start|Stop)-Process\b/i);
  assert.doesNotMatch(canary, /\b(?:Set-Content|Remove-Item|Set-Acl|New-Item)\b/i);
  assert.doesNotMatch(runner, /\b(?:Start|Stop)-Process\b/i);
  assert.doesNotMatch(runner, /\b(?:Enable|Disable|Set)-ScheduledTask\b/i);
  assert.doesNotMatch(runner, /\bNew-LocalUser\b|\bSet-LocalUser\b|\bnet user\b/i);
  assert.doesNotMatch(runner, /-Password\b|-Credential\b|Get-Credential\b/i);
  assert.ok(!/[^\x00-\x7f]/.test(runner), "runner is ASCII");
  assert.ok(!/[^\x00-\x7f]/.test(canary), "canary is ASCII");
});

test("P720 LocalService canary uses an immutable source and a transient no-trigger task", () => {
  assert.match(runner, /3a1659a5bcad7ed1448711ad797c7fb38cf30322/);
  assert.match(runner, /20ad7969a677df5a08f75557a3f286217d061f2c/);
  assert.match(runner, /\$git hash-object -- \$Tmp/);
  assert.match(runner, /\$git hash-object -- \$Dst/);
  assert.match(runner, /New-ScheduledTaskPrincipal.*-LogonType ServiceAccount/);
  assert.match(runner, /VerifyOurTask/);
  assert.match(runner, /@\(.*\.Triggers\)\.Count -ne 0/);
  assert.match(runner, /Start-ScheduledTask -TaskName \$TaskName/);
  assert.match(runner, /Stop-ScheduledTask -TaskName \$TaskName/);
  assert.match(runner, /Unregister-ScheduledTask -TaskName \$TaskName/);
  assert.doesNotMatch(runner, /Unregister-ScheduledTask -TaskName \$OriginalTask/);
  assert.doesNotMatch(runner, /Start-ScheduledTask -TaskName \$OriginalTask/);
  assert.match(runner, /CANARY_TASK_MANUAL_REVIEW/);
  assert.match(runner, /CANARY_STAGE_MANUAL_REVIEW/);
  assert.match(canary, /S-1-5-19/);
  assert.match(canary, /KMJ_P720_SERVICE_CANARY_BLOCKER=LOCALSERVICE_SID_REQUIRED/);
  assert.match(canary, /Method = 'HEAD'/);
  assert.match(canary, /UseDefaultCredentials = \$false/);
  assert.match(canary, /FileReadableWithoutContents/);
  assert.match(canary, /KMJ_P720_SERVICE_CANARY=PASS_LIMITED/);
});

test(
  "Windows PowerShell parses both canary scripts and the read-only selftest passes",
  { skip: process.platform !== "win32" },
  () => {
    for (const name of [runnerName, canaryName]) {
      const command =
        "$tokens=$null;$errors=$null;" +
        "[Management.Automation.Language.Parser]::ParseFile('" +
        name.replace(/\//g, "\\") +
        "',[ref]$tokens,[ref]$errors)|Out-Null;" +
        "if($errors.Count -gt 0){exit 8};Write-Output 'PS_AST=PASS'";
      const stdout = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", timeout: 15000 },
      );
      assert.match(stdout, /PS_AST=PASS/);
    }
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", canaryName, "-SelfTest"],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.match(output, /KMJ_P720_SERVICE_CANARY_SELFTEST=PASS/);
    assert.match(output, /KMJ_P720_SERVICE_CANARY_AGENT_STARTED=NO/);
  },
);
