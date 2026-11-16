import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../scripts/windows/", import.meta.url);
const scripts = [
  "P520-SUPERVISOR-READINESS.ps1",
  "P520-SUPERVISOR-INSTALL-PREFLIGHT.ps1",
  "P520-SUPERVISOR-DISABLED-PREPARE.ps1",
  "install-windows-supervisor.ps1",
];

function runPowerShell(code) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", code],
    { encoding: "utf8", windowsHide: true, timeout: 20000 },
  );
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

for (const name of scripts) {
  test(
    "native PowerShell AST parser accepts " + name,
    { skip: process.platform !== "win32" },
    () => {
      const file = fileURLToPath(new URL(name, root));
      const safe = file.replaceAll("'", "''");
      const result = runPowerShell(
        "$t=$null; $errors=$null; " +
          "[System.Management.Automation.Language.Parser]::ParseFile('" +
          safe +
          "',[ref]$t,[ref]$errors) | Out-Null; " +
          "if(@($errors).Count -ne 0){exit 2}; " +
          "Write-Output 'P520_PS_AST_PARSE=PASS'",
      );
      assert.match(result, /P520_PS_AST_PARSE=PASS/);
    },
  );
}

test(
  "Windows Scheduler supports disabled-at-registration task settings",
  { skip: process.platform !== "win32" },
  () => {
    const result = runPowerShell(
      "$cmd=Get-Command New-ScheduledTaskSettingsSet -ErrorAction Stop; " +
        "if(-not $cmd.Parameters.ContainsKey('Disable')){exit 2}; " +
        "Write-Output 'P520_SCHEDULER_DISABLE_PARAMETER=PASS'",
    );
    assert.match(result, /P520_SCHEDULER_DISABLE_PARAMETER=PASS/);
  },
);
