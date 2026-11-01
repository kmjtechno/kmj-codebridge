import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/windows/P520-SUPERVISOR-READINESS.ps1", import.meta.url),
);

test("P520 supervisor readiness source never mutates Windows services", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /param\(\[switch\]\$SelfTest\)/);
  assert.match(source, /P520_READINESS_AUDIT/);
  assert.match(source, /Get-ScheduledTask/);
  assert.match(source, /Get-ScheduledTask -TaskPath/);
  assert.match(source, /Classify-TaskInventory/);
  assert.match(source, /QUERY_FAILED_UNATTESTED/);
  assert.doesNotMatch(
    source,
    /Get-ScheduledTask[^\r\n]*-ErrorAction SilentlyContinue/,
  );
  assert.match(source, /Get-NetTCPConnection/);
  for (const cmd of [
    "Register-ScheduledTask",
    "Unregister-ScheduledTask",
    "Set-ScheduledTask",
    "Start-ScheduledTask",
    "Stop-ScheduledTask",
    "New-ScheduledTask",
    "Start-Process",
    "Start-Service",
    "Stop-Service",
    "Restart-Service",
    "Set-ItemProperty",
    "Set-Acl",
    "icacls.exe",
    "New-Item",
    "Remove-Item",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp("^\\s*" + cmd.replace(".", "\\.") + "\\b", "im"),
    );
  }
  assert.match(source, /P520_SUPERVISOR_TASK_PROVENANCE' 'NOT_VERIFIED'/);
  assert.match(source, /P520_SUPERVISOR_TOKEN_ACL' 'NOT_VERIFIED'/);
  assert.match(source, /P520_SUPERVISOR_ACTIVATION' 'NOT_ATTEMPTED'/);
});

test(
  "native Windows read-only readiness selftest handles task and listener aliases",
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
    assert.match(result.stdout, /P520_SUPERVISOR_READINESS_SELFTEST=PASS/);
  },
);
