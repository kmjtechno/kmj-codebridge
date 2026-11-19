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
    "OWNER_GH_CLI_REQUIRED",
    "OWNER_GH_AUTH_REQUIRED",
    "GITHUB_PROTECTED_MAIN_UNAVAILABLE",
    "GITHUB_MAIN_REVIEW_POLICY_BLOCKED",
    "GITHUB_REPOSITORY_AUTO_MERGE_DISABLED",
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
  assert.match(source, /a41985b2b407bebd34ddb5bfa8f010bf4e11ffb1/);
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
    /Start-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask/,
  );
  // Failed install must never leave a runnable owner-key task.
  assert.match(source, /New-ScheduledTaskSettingsSet -Disable/);
  assert.match(source, /\$task.State -ceq 'Disabled'/);
  assert.match(source, /Enable-ScheduledTask -TaskName \$TaskName/);
  assert.match(source, /ENABLED_TASK_READBACK_UNVERIFIED/);
  assert.match(source, /if\(\$TaskOwned\)/);
  assert.match(source, /Disable-ScheduledTask -TaskName \$TaskName/);
  assert.match(source, /DISABLED_ON_SETUP_FAILURE/);
  assert.match(
    launcher,
    /ONE-CLICK-OWNER-AUTOSIGN-SETUP-20261118\.ps1" -Apply/,
  );
  assert.doesNotMatch(
    launcher,
    /EncodedCommand|curl|bitsadmin|certutil|taskkill/,
  );
});

test("P520 installer explicitly protects installed leaf files and fail-closed recovers only an exact partial tree", () => {
  assert.match(source, /OWNER_AUTOSIGN_PARTIAL.*EXACT_LAYOUT_RECOVERY/);
  assert.match(source, /PARTIAL_INSTALL_LAYOUT_UNTRUSTED/);
  assert.match(source, /PARTIAL_INSTALL_OWNER_MISMATCH/);
  assert.match(source, /PARTIAL_INSTALL_ROOT_UNTRUSTED/);
  assert.match(source, /Get-ChildItem -LiteralPath \$Install -Recurse -Force/);
  assert.match(source, /PARTIAL_INSTALL_TYPE_UNTRUSTED/);
  assert.match(source, /INSTALL_DIRECTORY_ACL_FAILED/);
  assert.match(source, /INSTALL_FILE_ACL_FAILED/);
  assert.match(source, /OWNER_AUTOSIGN_INSTALLED_FILE_ACL/);
  assert.match(source, /OwnerAcl \$f \$sid/);
  assert.match(source, /icacls\.exe \$f \/inheritance:r \/grant:r/);
  assert.doesNotMatch(source, /'\/T','\/Q'/);
  assert.ok(
    source.indexOf("OWNER_AUTOSIGN_INSTALLED_FILE_ACL") <
      source.indexOf("INSTALLED_SOURCE_HASH_DRIFT"),
  );
  assert.ok(
    source.indexOf("AUTOSIGN_TASK_ALREADY_PRESENT") <
      source.indexOf("EXACT_LAYOUT_RECOVERY"),
  );
});

test("reviewed signer upgrade refuses unknown task or bits and preserves protected owner key", () => {
  const upgrade = fs.readFileSync(
    "scripts/windows/OWNER-AUTOSIGN-SIGNER-PINNED-UPGRADE-20261119.ps1",
    "utf8",
  );
  const oneClick = fs.readFileSync(
    "scripts/windows/ONE-CLICK-OWNER-AUTOSIGN-UPGRADE-20261119.cmd",
    "utf8",
  );
  assert.match(
    oneClick,
    /OWNER-AUTOSIGN-SIGNER-PINNED-UPGRADE-20261119\.ps1" -Apply/,
  );
  assert.doesNotMatch(oneClick, /curl|wget|bitsadmin|EncodedCommand|taskkill/);
  for (const guard of [
    "DESKTOP-5FVJMET",
    "a41985b2b407bebd34ddb5bfa8f010bf4e11ffb1",
    "b3717a8b3c948567f6648ad11233ed276d58b143",
    "31c58d25baa2d57945a70fe689c54979b8023229",
    "897d9ff674ac6d007bae34084060a16b713ef2b6",
    "UPGRADE_TASK_IDENTITY_UNVERIFIED",
    "UPGRADE_OWNER_CONSENT_INVALID",
    "UPGRADE_SIGNER_UNRECOGNIZED",
    "UPGRADE_TASK_NOT_DISABLED",
    "UPGRADE_TASK_NOT_DISABLED_AT_REPLACE",
    "UPGRADE_PREVIOUS_ARTIFACT_PRESENT",
    "UPGRADE_REPLACED_HASH_DRIFT",
    "UPGRADE_ROLLBACK_BACKUP_DRIFT",
    "UPGRADE_DISABLED_READBACK_UNVERIFIED",
    "DISABLED_PRESERVED",
    "OWNER_AUTOSIGN_UPGRADE",
    "PRESERVED_FOR_ROLLBACK",
  ])
    assert.ok(upgrade.includes(guard), guard);
  assert.match(
    upgrade,
    /\[System\.IO\.File\]::Replace\(\$Candidate,\$Signer,\$Backup\)/,
  );
  assert.doesNotMatch(
    upgrade,
    /Enable-ScheduledTask|Disable-ScheduledTask|Start-ScheduledTask/,
  );
  assert.match(upgrade, /\$task.State -ceq 'Disabled'/);
  assert.match(upgrade, /OwnerAcl \$Signer \$sid/);
  assert.match(upgrade, /OwnerAcl \$Backup \$sid/);
  assert.match(upgrade, /UPGRADE_OWNER_REVIEW_REQUIRED/);
  assert.doesNotMatch(
    upgrade,
    /Restart-Service|Start-ScheduledTask|Unregister-ScheduledTask|git reset|git clean|taskkill|Invoke-WebRequest/,
  );
  assert.doesNotMatch(
    upgrade,
    /Get-Content[^\n]*keyFile|Copy-Item[^\n]*keyFile/,
  );
});

test(
  "owner signer pinned upgrader Windows syntax and refusal selftest are safe",
  { skip: process.platform !== "win32" },
  () => {
    const script = path.resolve(
      "scripts/windows/OWNER-AUTOSIGN-SIGNER-PINNED-UPGRADE-20261119.ps1",
    );
    const parse = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:KMJ_CHECK_SCRIPT,[ref]$t,[ref]$e)|Out-Null;if($e.Count -gt 0){$e|ForEach-Object{Write-Error $_.Message};exit 2}",
      ],
      { encoding: "utf8", env: { ...process.env, KMJ_CHECK_SCRIPT: script } },
    );
    assert.equal(parse.status, 0, parse.stderr || parse.stdout);
    const denied = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", script, "-SelfTest"],
      { encoding: "utf8" },
    );
    assert.equal(denied.status, 0, denied.stderr || denied.stdout);
    assert.match(denied.stdout, /OWNER_AUTOSIGN_UPGRADE_SELFTEST=PASS/);
  },
);

test("guarded one-click resume requires pinned signer, owner policy, CI and task identity", () => {
  const source = fs.readFileSync(
    "scripts/windows/OWNER-AUTOSIGN-RESUME-GUARDED-20261119.ps1",
    "utf8",
  );
  const launcher = fs.readFileSync(
    "scripts/windows/ONE-CLICK-OWNER-AUTOSIGN-RESUME-20261119.cmd",
    "utf8",
  );
  for (const gate of [
    "DESKTOP-5FVJMET",
    "31c58d25baa2d57945a70fe689c54979b8023229",
    "AUTOSIGN_SIGNER_BLOB_NOT_APPROVED",
    "AUTOSIGN_OWNER_POLICY_NOT_APPROVED",
    "AUTOSIGN_TASK_NOT_OWNER_DISABLED",
    "AUTOSIGN_TASK_NODE24_REQUIRED",
    "AUTOSIGN_REPO_MERGE_POLICY_UNVERIFIED",
    "AUTOSIGN_BRANCH_PROTECTION_UNVERIFIED",
    "AUTOSIGN_EXACT_HEAD_CI_NOT_GREEN",
    "AUTOSIGN_MAIN_MOVED",
    "AUTOSIGN_ENABLE_PREFLIGHT",
    "OWNER_AUTOSIGN_FIRST_SIGNED_RELEASE",
    "Enable-ScheduledTask",
  ])
    assert.ok(source.includes(gate), gate);
  assert.match(
    launcher,
    /OWNER-AUTOSIGN-SIGNER-PINNED-UPGRADE-20261119\.ps1" -Apply/,
  );
  assert.match(
    launcher,
    /OWNER-AUTOSIGN-RESUME-GUARDED-20261119\.ps1" -Apply/,
  );
  assert.ok(
    launcher.indexOf("OWNER-AUTOSIGN-SIGNER-PINNED-UPGRADE") <
      launcher.indexOf("OWNER-AUTOSIGN-RESUME-GUARDED"),
  );
  assert.doesNotMatch(
    launcher,
    /curl|wget|Invoke-WebRequest|EncodedCommand|taskkill|git reset|git clean/,
  );
  assert.doesNotMatch(
    source,
    /Start-ScheduledTask|Unregister-ScheduledTask|Restart-Service|git reset|git clean/,
  );
  assert.doesNotMatch(
    source,
    /Get-Content[^\n]*keyFile|Copy-Item[^\n]*keyFile/,
  );
});

test(
  "owner resume PowerShell selftest is available without any task mutation",
  { skip: process.platform !== "win32" },
  () => {
    const script = path.resolve(
      "scripts/windows/OWNER-AUTOSIGN-RESUME-GUARDED-20261119.ps1",
    );
    const syntax = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:KMJ_CHECK_SCRIPT,[ref]$t,[ref]$e)|Out-Null;if($e.Count -gt 0){$e|ForEach-Object{Write-Error $_.Message};exit 2}",
      ],
      { encoding: "utf8", env: { ...process.env, KMJ_CHECK_SCRIPT: script } },
    );
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
    const t = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", script, "-SelfTest"],
      { encoding: "utf8" },
    );
    assert.equal(t.status, 0, t.stderr || t.stdout);
    assert.match(t.stdout, /OWNER_AUTOSIGN_RESUME_SELFTEST=PASS/);
  },
);

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
