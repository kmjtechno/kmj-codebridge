import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";

const script = fs.readFileSync(
  "scripts/windows/PREPARE-P720-AGENT-TASK.ps1",
  "utf8",
);
const launcher = fs.readFileSync(
  "scripts/windows/PREPARE-P720-AGENT-TASK.cmd",
  "utf8",
);
test("task preparation is inactive by default, pinned and never starts duplicate agent", () => {
  assert.match(script, /param\(\[switch\]\$Apply\)/);
  assert.match(script, /AGENT_TASK_PREFLIGHT=PASS/);
  assert.match(script, /if \(-not \$Apply\)/);
  assert.match(script, /AGENT_TASK_ALREADY_EXISTS/);
  assert.match(script, /AGENT_TASK_EXISTING_AGENT_NOT_UNIQUE/);
  assert.match(script, /AGENT_TASK_PINNED_SHA_MISMATCH/);
  assert.match(script, /AGENT_TASK_RELEASE_NOT_IMMUTABLE/);
  assert.match(script, /AGENT_TASK_CONFIG_SCOPE_INVALID/);
  assert.match(script, /AGENT_TASK_OWNER_MISMATCH/);
  assert.match(script, /AGENT_TASK_RUNNING_NODE_MISMATCH/);
  assert.match(script, /Register-ScheduledTask/);
  assert.match(script, /Disable-ScheduledTask/);
  assert.match(script, /AGENT_TASK_PREPARED=DISABLED/);
  assert.match(script, /AGENT_TASK_ACTIVATED=NO/);
  assert.doesNotMatch(
    script,
    /Stop-Process|Start-Process|Start-ScheduledTask|Stop-ScheduledTask|Unregister-ScheduledTask|git reset|git clean|Restart-Service/i,
  );
  assert.match(launcher, /PREPARE-P720-AGENT-TASK\.ps1/);
  assert.match(launcher, /DISABLED_ONLY/);
  assert.doesNotMatch(launcher, /schtasks|Stop-Process|taskkill/i);
});
test("native supervisor never accepts disabled or unknown restart task state", () => {
  const src = fs.readFileSync("src/windows-supervisor.js", "utf8");
  assert.match(src, /state === "Ready" \|\| state === "Running"/);
  assert.match(src, /!task\.exists \|\| !task\.enabled/);
});
test("Windows PowerShell 5.1 accepts scheduled-task preparation parser", {
  skip: process.platform !== "win32",
}, () => {
  const parse = [
    "$tokens=$null;$errors=$null;",
    "[System.Management.Automation.Language.Parser]::ParseFile(",
    "'scripts/windows/PREPARE-P720-AGENT-TASK.ps1',",
    "[ref]$tokens,[ref]$errors) | Out-Null;",
    "if($errors.Count -gt 0){throw $errors[0].Message}",
  ].join(" ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", parse], {
    stdio: "pipe",
    timeout: 20000,
  });
});
