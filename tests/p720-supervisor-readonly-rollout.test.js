import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const script = fs.readFileSync(
  "scripts/windows/ROLLOUT-P720-READONLY-PROJECT.ps1",
  "utf8",
);
const verifier = fs.readFileSync(
  "scripts/windows/verify-p720-readonly-rollout.mjs",
  "utf8",
);
const launcher = fs.readFileSync(
  "scripts/windows/ROLLOUT-P720-READONLY-PROJECT.cmd",
  "utf8",
);

test("rollout verifies existing task, manifest, token, HMAC and authorized project", () => {
  const initialHmac = script.indexOf("Verify-OldHmac");
  const stage = script.indexOf("ROLLOUT_PREFLIGHT=PASS");
  const stagedHmac = script.indexOf("ROLLOUT_CANDIDATE_INVALID");
  const swap = script.indexOf(
    "[IO.File]::Replace($replace,$Config,$backupFile)",
  );
  const task = script.indexOf("Stop-ScheduledTask -TaskName $TaskName");
  const live = script.indexOf("& $node $Verifier live $Release $Config");
  assert.ok(initialHmac > 0 && stage > initialHmac);
  assert.ok(stagedHmac > stage && swap > stagedHmac);
  assert.ok(task > swap && live > task);
  assert.match(script, /ROLLOUT_MANIFEST_NOT_UNIQUE/);
  assert.match(script, /ROLLOUT_ORIGINAL_TASK_IDENTITY_CHANGED/);
  assert.match(script, /ROLLOUT_TOKEN_CHANGED/);
  assert.match(script, /ROLLOUT_SUPERVISOR_CONFIG_CHANGED/);
  assert.match(script, /ROLLOUT_OLD_HMAC_FAILED/);
  assert.match(script, /ROLLOUT_PINNED_SOURCE_MISMATCH/);
  assert.match(script, /if \(-not \$Apply\)/);
});

test("rollback restores exact original task and config with HMAC proof", () => {
  assert.match(
    script,
    /Set-ScheduledTask -TaskName \$TaskName -TaskPath '\\' -Action \$oldAction/,
  );
  assert.match(script, /ROLLOUT_RESTORE_HASH_MISMATCH/);
  assert.match(script, /ROLLOUT_ROLLBACK_HMAC_FAILED/);
  assert.match(script, /KMJ_ROLLOUT_ROLLBACK=PASS/);
  assert.match(script, /KMJ_ROLLOUT_ROLLBACK=FAILED_MANUAL_RECOVERY/);
  assert.doesNotMatch(
    script,
    /git reset|git clean|Unregister-ScheduledTask|Stop-Process|Restart-Service/i,
  );
  assert.match(launcher, /ROLLOUT-P720-READONLY-PROJECT\.ps1/);
  assert.match(launcher, /if not "%RC%"=="0"/);
});

test("post-cutover HMAC and denial-of-verification are mandatory", () => {
  assert.match(verifier, /mode !== "stage" && mode !== "live"/);
  assert.match(verifier, /UNAPPROVED_PROJECT_SCOPE/);
  assert.match(verifier, /READONLY_PROJECT_STATUS_INVALID/);
  assert.match(verifier, /project_verify_prepare/);
  assert.match(verifier, /READONLY_WRITE_REFUSAL_NOT_CONFIRMED/);
  assert.match(verifier, /KMJ_PROJECT_ROLLOUT_LIVE=HMAC_AND_READONLY_PASS/);
  assert.doesNotMatch(verifier, /console\.log\([^)]*token/);
});

test(
  "native Windows PowerShell parser accepts the cutover without executing it",
  { skip: process.platform !== "win32" },
  () => {
    const source = [
      "$tok=$null;$errors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "'scripts/windows/ROLLOUT-P720-READONLY-PROJECT.ps1',",
      "[ref]$tok,[ref]$errors) | Out-Null;",
      "if($errors.Count -gt 0){throw $errors[0].Message}",
    ].join(" ");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", source], {
      timeout: 20000,
      stdio: "pipe",
    });
  },
);
