import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const script = fs.readFileSync(
  "scripts/windows/HANDOFF-P720-AGENT-SUPERVISOR.ps1",
  "utf8",
);
const guard = fs.readFileSync(
  "scripts/windows/verify-p720-agent-handoff.mjs",
  "utf8",
);
const launch = fs.readFileSync(
  "scripts/windows/HANDOFF-P720-AGENT-SUPERVISOR.cmd",
  "utf8",
);

test("handoff cannot mutate until manifest, HMAC, idle and unique agent proof", () => {
  const hmac = script.indexOf("& $node $Hmac $backupDir");
  const check = script.indexOf("& $node $Guard $backupDir");
  const idle = script.indexOf("Assert-Idle\n  $originalHash");
  const stop = script.indexOf("Stop-Process -Id $oldPid");
  const switchConfig = script.indexOf(
    "[IO.File]::Replace($temp,$Config,$backupFile)",
  );
  assert.ok(check > 0 && hmac > check && idle > hmac);
  assert.ok(switchConfig > idle && stop > switchConfig);
  assert.match(script, /Get-ScheduledTask -TaskName \$TaskName -TaskPath '\\'/);
  assert.match(script, /HANDOFF_SUPERVISOR_NOT_RUNNING/);
  assert.match(script, /HANDOFF_AGENT_CHANGED_DURING_PREFLIGHT/);
  assert.match(script, /HANDOFF_ACTIVE_JOBS/);
  assert.match(script, /HANDOFF_ACTIVE_AUTOPILOT/);
  assert.match(script, /HANDOFF_MULTIPLE_AGENTS/);
  assert.match(script, /HANDOFF_PROPOSAL_INTEGRITY_FAILED/);
  assert.match(script, /KMJ_HANDOFF_NEW_AGENT_HEARTBEAT=PASS/);
});
test("handoff preserves old agent and config on failure", () => {
  assert.match(script, /KMJ_HANDOFF_CONFIG_ROLLBACK=PASS/);
  assert.match(script, /HANDOFF_ROLLBACK_HASH_MISMATCH/);
  assert.match(script, /KMJ_HANDOFF_OLD_AGENT_ROLLBACK=PASS/);
  assert.match(script, /HANDOFF_ROLLBACK_AGENT_CONFLICT/);
  assert.match(script, /AGENT_NODE_EXECUTABLE_MISMATCH/);
  assert.match(script, /HANDOFF_EXISTING_AGENT_RELEASE_REQUIRES_REVIEW/);
  assert.match(script, /CINECORE=UNTOUCHED/);
  assert.doesNotMatch(
    script,
    /git reset|git clean|Unregister-ScheduledTask|Stop-ScheduledTask|Disable-ScheduledTask/i,
  );
  assert.match(launch, /HANDOFF-P720-AGENT-SUPERVISOR\.ps1/);
  assert.match(launch, /if not "%RC%"=="0"/);
});
test("config preflight only approves the two wire fields and known hashes", () => {
  assert.match(guard, /delete originalOnly\.supervisorPipe/);
  assert.match(guard, /delete originalOnly\.supervisorTokenFile/);
  assert.match(guard, /deepStrictEqual\(originalOnly, agent/);
  assert.match(guard, /HANDOFF_AGENT_ALREADY_WIRED/);
  assert.match(guard, /HANDOFF_MANIFEST_INVALID/);
  assert.match(guard, /HANDOFF_TOKEN_CHANGED/);
  assert.match(guard, /HANDOFF_PROPOSAL_CHANGED/);
  assert.match(guard, /HANDOFF_ORIGINAL_CONFIG_CHANGED/);
  assert.match(guard, /HANDOFF_SUPERVISOR_SCOPE_MISMATCH/);
  assert.doesNotMatch(guard, /console\.log\([^)]*agent\.token/);
});
test(
  "handoff verifier and native PowerShell parse without executing work",
  { skip: process.platform !== "win32" },
  () => {
    const code = [
      "$tok=$null; $errors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "'scripts/windows/HANDOFF-P720-AGENT-SUPERVISOR.ps1',",
      "[ref]$tok,[ref]$errors) | Out-Null;",
      "if($errors.Count -gt 0){throw $errors[0].Message}",
    ].join(" ");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", code], {
      timeout: 20000,
      stdio: "pipe",
    });
  },
);
