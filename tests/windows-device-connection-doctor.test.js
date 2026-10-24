import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(
  "scripts/windows/CODEBRIDGE-DEVICE-DOCTOR.ps1",
  "utf8",
);

test("Windows local PC doctor never reads enrollment secrets or mutates a device", () => {
  assert.match(source, /CREDENTIALS_READ = 'NO'/);
  assert.match(source, /GATEWAY_AUTHENTICATED = 'NOT_VERIFIED'/);
  assert.match(source, /TrustedRuntimeStatus/);
  assert.match(source, /CandidateCount/);
  assert.match(source, /Get-CimInstance Win32_Process/);
  assert.match(source, /DEVICE_HOST_MATCH/);
  assert.match(source, /OWNER_CHECKOUT = 'UNTOUCHED'/);
  assert.match(source, /USE_APPROVED_RECONNECT_LAUNCHER/);
  assert.match(source, /USE_OWNER_APPROVED_PAIRING_LAUNCHER/);
  for (const forbidden of [
    /Get-Content/i,
    /ConvertFrom-Json/i,
    /Set-Content/i,
    /Clear-Content/i,
    /Remove-Item/i,
    /Stop-Process/i,
    /Start-Process/i,
    /Start-Service/i,
    /Restart-Service/i,
    /Register-ScheduledTask/i,
    /Invoke-WebRequest/i,
    /Invoke-RestMethod/i,
    /git(?:\.exe)?\s+reset/i,
    /git(?:\.exe)?\s+clean/i,
    /icacls\.exe/i,
    /enroll-device\.js/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("separate device launcher choices keep existing enrollment boundaries", () => {
  const paths = [
    ["CHECK-HOMEOFFICE-CODEBRIDGE.cmd", "HomeOffice"],
    ["CHECK-P720-CODEBRIDGE.cmd", "P720"],
  ];
  for (const [file, mode] of paths) {
    const cmd = fs.readFileSync("scripts/windows/" + file, "utf8");
    assert.match(cmd, /%~dp0CODEBRIDGE-DEVICE-DOCTOR\.ps1/);
    assert.match(cmd, new RegExp("-Device " + mode + "\\b"));
    assert.match(cmd, /-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned/);
    assert.doesNotMatch(
      cmd,
      /ExecutionPolicy Bypass|git\s+clone|curl\b|token\s*=|Set-Content|Start-Service/i,
    );
  }
});

test(
  "native Windows PowerShell parses the doctor and executes only its isolated self-test",
  { skip: process.platform !== "win32" },
  () => {
    const run = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        "scripts/windows/CODEBRIDGE-DEVICE-DOCTOR.ps1",
        "-Device",
        "HomeOffice",
        "-SelfTest",
      ],
      { encoding: "utf8", shell: false, windowsHide: true, timeout: 20000 },
    );
    assert.equal(run.status, 0, String(run.stderr).slice(-500));
    assert.match(run.stdout, /KMJ_PC_DOCTOR_SELFTEST=PASS/);
    assert.match(run.stdout, /CREDENTIALS_READ=NO/);
    assert.match(run.stdout, /HOST_CHANGES=NONE/);
  },
);
