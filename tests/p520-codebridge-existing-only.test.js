import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const script = "scripts/windows/RECONNECT-P520-CODEBRIDGE-EXISTING.ps1";
const source = readFileSync(script, "utf8");
const existing = readFileSync("scripts/windows/ONE-CLICK-ANY-DEVICE.ps1", "utf8");

test("P520 recovery pins CodeBridge, not Calibration Pro", () => {
  assert.match(source, /\$hostPin = 'DESKTOP-5FVJMET'/);
  assert.match(source, /\$devicePin = 'kmj-kmj-codebridge-desktop-5fvjmet'/);
  assert.match(source, /\$projectPin = 'kmj-codebridge'/);
  assert.match(source, /\$gatewayPin = 'https:\/\/kmjtechno\.com'/);
  assert.doesNotMatch(source, /homeoffice-calibration-pro|kmj-calibration-pro/);
});

test("read-only is default; reconnect requires -Apply", () => {
  assert.match(source, /param\(\[switch\]\$Apply,\[switch\]\$SelfTest\)/);
  assert.match(source, /if \(!\$Apply\) \{ Mark 'P520_CODEBRIDGE_RECOVERY' 'CHECK_ONLY'/);
  assert.match(source, /if \(\$hits\.Count -eq 0\) \{ throw 'NO_EXISTING_SCOPED_ENROLLMENT' \}/);
  assert.match(source, /if \(\$hits\.Count -ne 1\) \{ throw 'AMBIGUOUS_ENROLLMENT' \}/);
});

test("recovery never revokes, pairs or exports a private grant", () => {
  assert.doesNotMatch(source, /\b(Revoke-|Remove-Item|Reset-|FirstPair|PAIR-HOMEOFFICE|Start-Process\s+-Verb\s+RunAs)\b/i);
  assert.doesNotMatch(source, /Write-Output\s+\$(cfg|config|token)\b/i);
  assert.match(source, /-File \$entry -ConfigPath \$config/);
  assert.match(existing, /if \(\[string\]::IsNullOrWhiteSpace\(\$ConfigPath\)\) \{/);
});

test("strict private provenance and bounded enrollment discovery", () => {
  assert.match(source, /-Recurse -Depth 6/);
  assert.match(source, /Select-Object -First 129/);
  assert.match(source, /\$items\.Count -gt 128/);
  assert.match(source, /FileAttributes\]::ReparsePoint/);
  assert.match(source, /hash-object -- \$entry/);
  assert.match(source, /--no-optional-locks -C \$Root status --porcelain=v1/);
  assert.match(source, /\[string\]\$cfg\.id -cne \$devicePin/);
});

test("PowerShell self-test never starts an agent", { skip: process.platform !== "win32" }, () => {
  const ps = String(process.env.SystemRoot) + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const result = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-File", script, "-SelfTest"], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /P520_CODEBRIDGE_SELFTEST=PASS/);
  assert.match(result.stdout, /AGENT_STARTED=NO/);
});
