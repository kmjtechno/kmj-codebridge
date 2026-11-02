import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL(
    "../scripts/windows/P520-SUPERVISOR-INSTALL-PREFLIGHT.ps1",
    import.meta.url,
  ),
);

test("P520 supervisor install discovery is read-only and secret-redacted", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /P520_INSTALL_AGENT_CONFIG/);
  assert.match(source, /P520_INSTALL_ACTION' 'NONE'/);
  assert.match(source, /P520_INSTALL_TASK_PROVENANCE' 'NOT_VERIFIED'/);
  assert.match(source, /ONE_UNATTESTED_CANDIDATE/);
  assert.match(source, /Get-ScheduledTask -ErrorAction Stop/);
  assert.match(source, /Get-ChildItem -LiteralPath \$root -Recurse -Depth 3/);
  assert.doesNotMatch(source, /Write-Output\s+\$cfg\b/);
  assert.doesNotMatch(source, /Get-Content.*Write-Output/);
  for (const command of [
    "New-Item",
    "Set-Content",
    "Out-File",
    "Set-Acl",
    "icacls.exe",
    "Register-ScheduledTask",
    "Start-ScheduledTask",
    "Enable-ScheduledTask",
    "Unregister-ScheduledTask",
    "Remove-Item",
    "Restart-Service",
    "Start-Process",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp("^\\s*" + command.replace(".", "\\.") + "\\b", "im"),
    );
  }
});

test(
  "native Windows P520 config discovery selftest rejects other project and task collision",
  { skip: process.platform !== "win32" },
  () => {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        script,
        "-SelfTest",
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /P520_INSTALL_PREFLIGHT_SELFTEST=PASS/);
  },
);
