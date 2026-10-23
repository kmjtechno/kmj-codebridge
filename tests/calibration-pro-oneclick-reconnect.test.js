import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const psFile = path.resolve("scripts/windows/CONNECT-CALIBRATION-PRO.ps1");
const cmdFile = path.resolve("scripts/windows/CONNECT-CALIBRATION-PRO.cmd");
const ps = fs.readFileSync(psFile, "utf8");
const cmd = fs.readFileSync(cmdFile, "utf8");

test("Calibration Pro owner double click is narrowly scoped to existing enrollment", () => {
  assert.match(cmd, /%~dp0CONNECT-CALIBRATION-PRO\.ps1/);
  assert.match(cmd, /-NoProfile -STA -ExecutionPolicy RemoteSigned -File/);
  assert.doesNotMatch(cmd, /ExecutionPolicy Bypass|schtasks|setx |npm |git /i);
  for (const marker of [
    "kmj-homeoffice-desktop-5fvjmet",
    "kmj-calibration-pro",
    "https://kmjtechno.com",
    "ENROLLED_SCOPE_MISMATCH",
    "PRIVATE_CONFIG_REQUIRED",
    "UNTRUSTED_CALIBRATION_REPOSITORY",
    "UNTRUSTED_RUNTIME_ORIGIN",
    "RUNTIME_TRACKED_CHANGES",
    "NODE24_REQUIRED",
    "CALIBRATION_RECONNECT_SELFTEST=PASS",
  ]) assert.ok(ps.includes(marker), "Missing safety marker: " + marker);
  assert.match(ps, /System\.Windows\.Forms\.OpenFileDialog/);
  assert.match(ps, /\$picker\.ShowDialog\(\)/);
  assert.match(ps, /param\(\[string\]\$ConfigPath/);
  assert.match(ps, /PrivatePath \$ConfigPath/);
});

test("Reconnect never edits owner files, exports secrets, self-repairs or starts a second agent", () => {
  assert.match(ps, /ExistingLock \$state/);
  assert.match(ps, /ScopedAgents \$ConfigPath/);
  assert.match(ps, /DUPLICATE_SCOPED_AGENTS/);
  assert.match(ps, /AGENT_LOCK_OWNER_ALIVE/);
  assert.match(ps, /AGENT_LOCK_OWNER_MISMATCH/);
  assert.match(ps, /AGENT_SCOPE_RACE_DETECTED/);
  assert.match(ps, /CALIBRATION_RECONNECT=ALREADY_RUNNING_LOCALLY/);
  assert.match(ps, /FRESH_AUTHENTICATED_HEARTBEAT_MISSING/);
  assert.match(ps, /LOCAL_AUTHENTICATED_HEARTBEAT/);
  assert.match(ps, /ACCOUNT_GRANT=CHECK_CODEBRIDGE_CONNECTION_OVERVIEW/);
  assert.match(ps, /Get-CimInstance Win32_Process/);
  assert.match(ps, /-MaximumRedirection 0/);
  assert.match(ps, /StatusCode -ne 401/);
  assert.match(ps, /ENROLLMENT=UNCHANGED/);
  assert.match(ps, /OWNER_CHECKOUT=UNTOUCHED/);
  assert.doesNotMatch(ps, /\b(?:Stop-Process|Register-ScheduledTask|Start-ScheduledTask|Invoke-Expression|Set-Content|Remove-Item|Remove-File|Invoke-RestMethod)\b/i);
  assert.doesNotMatch(ps, /git(?:\.exe)?\b[^\n]*(?:\breset\b|\bclean\b|\bpull\b|\bfetch\b|\bmerge\b)/i);
  assert.doesNotMatch(ps, /GITHUB_TOKEN|gh auth token|OPENAI_API_KEY|-ExecutionPolicy Bypass/);
});

test("Native Windows PowerShell parser and fake-scope negative tests pass", (t) => {
  if (process.platform !== "win32") {
    t.skip("Live PowerShell syntax and scope test runs on Windows CI");
    return;
  }
  const safe = psFile.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$tokens=$null;$errors=$null",
    "[System.Management.Automation.Language.Parser]::ParseFile('" + safe + "',[ref]$tokens,[ref]$errors) | Out-Null",
    "if($errors.Count -gt 0) { exit 2 }",
    "& '" + safe + "' -SelfTest",
    "if($LASTEXITCODE -ne 0) { exit 3 }",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 20000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /CALIBRATION_RECONNECT_SELFTEST=PASS/);
});
