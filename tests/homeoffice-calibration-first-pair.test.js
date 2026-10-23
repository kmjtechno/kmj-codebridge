import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve("scripts", "windows");
const psPath = path.join(root, "PAIR-HOMEOFFICE-CALIBRATION.ps1");
const cmdPath = path.join(root, "PAIR-HOMEOFFICE-CALIBRATION.cmd");
const ps = fs.readFileSync(psPath, "utf8");
const cmd = fs.readFileSync(cmdPath, "utf8");

test("first-pair launcher is Home Office only and requires owner-browser approval", () => {
  assert.match(cmd, /%~dp0PAIR-HOMEOFFICE-CALIBRATION\.ps1/);
  assert.match(cmd, /-NoProfile -STA -ExecutionPolicy RemoteSigned -File/);
  assert.doesNotMatch(cmd, /ExecutionPolicy Bypass|RunAs|schtasks|npm |git |setx /i);
  for (const marker of [
    "kmj-homeoffice-desktop-5fvjmet",
    "kmj-calibration-pro",
    "desktop-5fvjmet",
    "E:\\KMJ\\Codex\\KMJ CalibrationNew",
    "https://kmjtechno.com",
    "scripts\\enroll-device.js",
    "CODEBRIDGE_RUNTIME_DIRTY",
    "ENROLLMENT_IDENTITY_SCOPE_OR_GATEWAY_MISMATCH",
    "EXISTING_HOMEOFFICE_AGENT_RECONNECT_INSTEAD",
    "HOMEOFFICE_PAIR_SELFTEST=PASS",
    "OWNER_APPROVED_PRIVATE_ENROLLMENT_SAVED",
    "CHECK_CONNECTION_OVERVIEW",
    "calibration-v4-software-qa",
  ]) assert.ok(ps.includes(marker), "Safety marker missing: " + marker);

  assert.match(ps, /Get-ChildItem[^\n]*-Filter 'agent\.json'/);
  assert.match(ps, /Trusted-Git \$ProjectRoot \$origins/);
  assert.match(ps, /Trusted-Git \$runtime \$runtimeOrigins/);
  assert.match(ps, /Valid-Grant \$grant/);
  assert.match(ps, /FileMode\]::CreateNew/);
  assert.match(ps, /Private-Acl \$configFile \$false/);
  assert.match(ps, /CONNECT-CALIBRATION-PRO\.ps1/);
  assert.doesNotMatch(ps, /['"]D:\\KMJ-HyperSpeed\\projects\\kmj-codebridge/);
  assert.doesNotMatch(ps, /\b(?:Stop-Process|Remove-Item|Clear-Content|Set-Service|Start-Service|Register-ScheduledTask|Set-Date|Invoke-Expression)\b/i);
});

test("first-pair payload stays private and does not bypass production approval", () => {
  assert.match(ps, /OWNER_PC_SCOPE=PASS/);
  assert.match(ps, /PRODUCTION_PAIRING_FIX_DEPLOYED=NOT_VERIFIED/);
  assert.match(ps, /CheckOnly/);
  assert.match(ps, /BLOCKED_OWNER_APPROVAL_OR_PLATFORM_GATEWAY/);
  assert.match(ps, /ACCOUNT_SIDE_READY=CHECK_CONNECTION_OVERVIEW/);
  assert.match(ps, /grant\.agent\.token/);
  assert.doesNotMatch(ps, /Write-(?:Output|Host)[^\n]*(?:\$grant\.agent\.token|\$configFile|\$enrollment)/i);
  assert.doesNotMatch(ps, /git(?:\.exe)?\b[^\n]*(?:\breset\b|\bclean\b|\bpull\b|\bfetch\b|\bmerge\b)/i);
});

test("native Windows PowerShell parses first-pair script and rejects P720 scope", (t) => {
  if (process.platform !== "win32") {
    t.skip("Native PowerShell regression requires Windows CI");
    return;
  }
  const escaped = psPath.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$tokens=$null;$errors=$null",
    "[System.Management.Automation.Language.Parser]::ParseFile('" +
      escaped + "',[ref]$tokens,[ref]$errors) | Out-Null",
    "if($errors.Count -gt 0) { exit 2 }",
    "& '" + escaped + "' -SelfTest",
    "if($LASTEXITCODE -ne 0) { exit 3 }",
  ].join("; ");
  const child = spawnSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 20000, windowsHide: true });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /HOMEOFFICE_PAIR_SELFTEST=PASS/);
});
