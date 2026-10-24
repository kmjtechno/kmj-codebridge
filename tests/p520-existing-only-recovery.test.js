import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const psPath = path.resolve("scripts/windows/RECOVER-P520-EXISTING-ONLY.ps1");
const cmdPath = path.resolve("scripts/windows/START-KMJ-P520-EXISTING-ONLY.cmd");
const ps = fs.readFileSync(psPath, "utf8");
const cmd = fs.readFileSync(cmdPath, "utf8");
const expected = "6610643B27ECBB903ECAA91BF1DDDBF591DE344226FA8E3ECC5CA93E9C3C9276";

test("P520 existing-only double-click launcher pins exact reviewed SHA256", () => {
  assert.equal(
    createHash("sha256").update(fs.readFileSync(psPath)).digest("hex").toUpperCase(),
    expected,
  );
  assert.ok(cmd.includes(expected));
  assert.match(cmd, /DESKTOP-5FVJMET/);
  assert.match(cmd, /Get-FileHash/);
  assert.match(cmd, /Unblock-File -LiteralPath/);
  assert.match(cmd, /SCRIPT_CHANGED/);
  assert.match(cmd, /-ExecutionPolicy RemoteSigned/);
  assert.match(cmd, /KMJ_P520_RECOVERY_EXIT=/);
  assert.doesNotMatch(cmd, /ExecutionPolicy Bypass|Set-ExecutionPolicy|schtasks|curl|invoke-webrequest|token\s*=/i);
});

test("P520 existing-only recovery never registers another device or changes project files", () => {
  assert.match(ps, /\$expectedHost = 'DESKTOP-5FVJMET'/);
  assert.match(ps, /\$pin = '9f74b7a88a3bc4f163f43c04328fe753db094354'/);
  assert.match(ps, /-AutoDiscover','-NoPicker/);
  assert.match(ps, /CONNECT-CALIBRATION-PRO\.ps1/);
  assert.match(ps, /RECOVERY_EXISTING_SCOPED_CREDENTIAL_NOT_FOUND/);
  assert.match(ps, /RECOVERY_PINNED_CLEAN_RUNTIME_MISSING/);
  assert.match(ps, /KMJ_P520_NEW_PAIRING_STARTED/);
  assert.match(ps, /LOCAL_AUTHENTICATED_HEARTBEAT/);
  assert.match(ps, /CHECK_CODEBRIDGE_ACCOUNT_SIDE/);
  assert.match(ps, /-untracked-files=no|--untracked-files=no/);
  assert.match(ps, /hash-object -- \$entry/);
  assert.match(ps, /HEAD:' \+ \$relative/);
  assert.doesNotMatch(
    ps,
    /enroll-device|PAIR-HOMEOFFICE|Invoke-WebRequest|Invoke-RestMethod|Register-ScheduledTask|Start-ScheduledTask|Set-ExecutionPolicy|git\s+reset|git\s+clean|Remove-Item|Copy-Item|New-Item/i,
  );
});

test(
  "existing-only Windows native selftest needs no live device or enrollment",
  { skip: process.platform !== "win32" },
  () => {
    const p = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", psPath, "-SelfTest"],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /KMJ_P520_EXISTING_ONLY_SELFTEST=PASS/);
    assert.match(p.stdout, /NETWORK_OR_LOCAL_FILES_MODIFIED=NO/);
  },
);
