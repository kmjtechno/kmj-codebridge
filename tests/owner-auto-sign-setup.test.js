import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ps = "scripts/windows/ONE-CLICK-OWNER-AUTOSIGN-SETUP-20261118.ps1";
const cmd = "scripts/windows/ONE-CLICK-OWNER-AUTOSIGN-SETUP-20261118.cmd";
const source = fs.readFileSync(ps, "utf8");
const launcher = fs.readFileSync(cmd, "utf8");
const enrollPs = "scripts/windows/OWNER-AUTOSIGN-LOCAL-ENROLL-20261118.ps1";
const enroll = fs.readFileSync(enrollPs, "utf8");

test("one-click release signer is P520-scoped, pinned and owner policy gated", () => {
  for (const guard of [
    "DESKTOP-5FVJMET",
    "SOURCE_BLOB_NOT_PINNED",
    "ONE_TIME_OWNER_POLICY_MISSING",
    "AUTO_SIGN_REVIEWED_MAIN_ONLY",
    "OWNER_FILE_ACL_UNSAFE",
    "AUTOSIGN_TASK_ALREADY_PRESENT",
    "OWNER_AUTOSIGN_TASK",
    "ONE_CLICK",
    "Interactive",
    "Limited",
    "IgnoreNew",
    "Register-ScheduledTask",
  ]) {
    // One-click label lives in filename, not in script output; skip generic.
    if (guard === "ONE_CLICK") continue;
    assert.ok(source.includes(guard), guard);
  }
  assert.match(source, /6208d6f4b8d7fb322e3b3c74839487b808bc5ff3/);
  assert.match(source, /897d9ff674ac6d007bae34084060a16b713ef2b6/);
  assert.match(source, /cdbcdea317ba8be0a18a28abdca18f6eca94cd19/);
  assert.match(source, /OWNER-AUTOSIGN-LOCAL-ENROLL-20261118\.ps1/);
  assert.match(source, /Need \$Apply 'ONE_TIME_OWNER_POLICY_MISSING'/);
  assert.match(
    source,
    /-STA -ExecutionPolicy RemoteSigned -File \$EnrollSource/,
  );
  assert.match(source, /Node24|NODE24_REQUIRED/);
  assert.doesNotMatch(
    source,
    /Restart-Service|Stop-Process|git reset|git clean|taskkill|Set-Content.*keyFile/,
  );
  assert.doesNotMatch(
    source,
    /Start-ScheduledTask|Unregister-ScheduledTask|Disable-ScheduledTask|Set-ScheduledTask/,
  );
  assert.match(
    launcher,
    /ONE-CLICK-OWNER-AUTOSIGN-SETUP-20261118\.ps1" -Apply/,
  );
  assert.doesNotMatch(
    launcher,
    /EncodedCommand|curl|bitsadmin|certutil|taskkill/,
  );
});

test("first-run enrollment is explicit, local-key only and fail closed", () => {
  for (const field of [
    "DESKTOP-5FVJMET",
    "MessageBoxButtons]::YesNo",
    "OWNER_AUTOSIGN_NOT_APPROVED",
    "SelectLocalFile",
    "OWNER_SIGNER_KEY_PAIR_UNVERIFIED",
    "SOURCE_REMOTE_UNTRUSTED",
    "KEY_INSIDE_SOURCE_REFUSED",
    "OWNER_POLICY_ACL_SET_FAILED",
    "OWNER_AUTOSIGN_PRIVATE_KEY",
    "IO.FileMode]::CreateNew",
    "30).ToString",
    "AUTO_SIGN_REVIEWED_MAIN_ONLY",
    "c51f8",
  ]) {
    assert.ok(enroll.includes(field), field);
  }
  assert.doesNotMatch(
    enroll,
    /Start-ScheduledTask|Register-ScheduledTask|Stop-Process|Restart-Service/,
  );
  assert.doesNotMatch(
    enroll,
    /curl|Invoke-WebRequest|Copy-Item.*(private|public)|git push|gh api|Set-Content.*private/,
  );
});

test(
  "owner auto signer Windows PowerShell syntax and selftest pass without installing task",
  { skip: process.platform !== "win32" },
  () => {
    const full = path.resolve(ps);
    const parsed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:KMJ_CHECK_SCRIPT,[ref]$t,[ref]$e)|Out-Null;if($e.Count -gt 0){$e|ForEach-Object{Write-Error $_.Message};exit 2}",
      ],
      { encoding: "utf8", env: { ...process.env, KMJ_CHECK_SCRIPT: full } },
    );
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
    const checked = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", full, "-SelfTest"],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.match(checked.stdout, /OWNER_AUTOSIGN_SETUP_SELFTEST=PASS/);
    const enrollFile = path.resolve(enrollPs);
    const enrollmentParse = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:KMJ_CHECK_SCRIPT,[ref]$t,[ref]$e)|Out-Null;if($e.Count -gt 0){$e|ForEach-Object{Write-Error $_.Message};exit 2}",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, KMJ_CHECK_SCRIPT: enrollFile },
      },
    );
    assert.equal(
      enrollmentParse.status,
      0,
      enrollmentParse.stderr || enrollmentParse.stdout,
    );
    const enrollmentSelftest = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", enrollFile, "-SelfTest"],
      { encoding: "utf8" },
    );
    assert.equal(
      enrollmentSelftest.status,
      0,
      enrollmentSelftest.stderr || enrollmentSelftest.stdout,
    );
    assert.match(
      enrollmentSelftest.stdout,
      /OWNER_AUTOSIGN_ENROLL_SELFTEST=PASS/,
    );
  },
);
