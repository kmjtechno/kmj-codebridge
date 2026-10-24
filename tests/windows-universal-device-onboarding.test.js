import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const script = "scripts/windows/ONE-CLICK-ANY-DEVICE.ps1";
const content = fs.readFileSync(script, "utf8");

test("any Windows PC can enroll without a hard-coded PC or project identity", () => {
  assert.match(content, /\$env:COMPUTERNAME/);
  assert.match(content, /\$hostSlug/);
  assert.match(content, /function ValidScope/);
  assert.match(content, /EndsWith\('-' \+ \$hostSlug/);
  assert.match(content, /DEVICE_ENROLLMENT_OR_HOST_SCOPE_MISMATCH/);
  assert.match(content, /function ChooseExisting/);
  assert.match(content, /function SelectProject/);
  assert.match(content, /function FirstPair/);
  assert.match(content, /scripts\\enroll-device\.js/);
  assert.match(content, /DEVICE_APPROVAL_GRANT_MISMATCH/);
  assert.match(content, /DEVICE_APPROVAL_PERMISSION_MISMATCH/);
  assert.match(content, /FileMode\]::CreateNew/);
  assert.match(content, /LockedACL \$config \$false/);
  assert.match(content, /KMJ_UNIVERSAL=OWNER_BROWSER_APPROVAL_REQUIRED/);
  assert.match(content, /-Wait -PassThru -NoNewWindow/);
  assert.doesNotMatch(content, /DESKTOP-5FVJMET|DESKTOP-K3AHHEM/);
});

test("automatic startup reuses exact private config, blocks duplicates and is reversible", () => {
  for (const marker of [
    "DEVICE_UNATTENDED_REQUIRES_EXACT_CONFIG",
    "DEVICE_DUPLICATE_APPROVED_AGENTS",
    "DEVICE_LOCK_PROCESS_MISMATCH",
    "DEVICE_LIVE_LOCK_OWNER_BLOCKS_START",
    "DEVICE_AGENT_START_RACE_BLOCKED",
    "DEVICE_AGENT_EXITED_BEFORE_HEARTBEAT",
    "DEVICE_FRESH_HEARTBEAT_UNVERIFIED",
    "DEVICE_EXISTING_P720_STARTUP_OWNER",
    "DEVICE_STARTUP_SHORTCUT_CONFLICT",
    "DEVICE_STARTUP_POSTWRITE_CHECK_FAILED",
    "DEVICE_CODEBRIDGE_RUNTIME_UNTRUSTED",
    "DEVICE_CODEBRIDGE_RUNTIME_DIRTY_PRESERVED",
    "DEVICE_UNTRACKED_LAUNCHER_BLOCKED",
    "KMJ_UNIVERSAL=ONE_CLICK_CURRENT_USER_AUTOSTART_ENABLED",
    "KMJ_UNIVERSAL=AUTOSTART_DISABLED",
    "KMJ_UNIVERSAL=SIGN_IN_RECONNECT_INVOKED",
    "ACCOUNT_READY=CHECK_AUTHENTICATED_CONNECTION_OVERVIEW",
  ]) assert.ok(content.includes(marker), marker);
  assert.match(content, /\[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::Startup\)/);
  assert.match(content, /-AtLogon -ConfigPath/);
  assert.match(content, /if \(\$AtLogon -or \$DisableAutoStart\)/);
  assert.match(content, /if \(\$DisableAutoStart\) \{/);
  assert.match(content, /Remove-Item -LiteralPath \$file/);
  for (const forbidden of [
    /\bRegister-ScheduledTask\b/,
    /\bEnable-ScheduledTask\b/,
    /\bStart-ScheduledTask\b/,
    /\bStop-Process\b/,
    /\bRestart-Service\b/,
    /\bSet-Service\b/,
    /\bInvoke-Expression\b/,
    /\bCopy-Item\b/,
    /\bgit\s+reset\b/i,
    /\bgit\s+clean\b/i,
    /\bGITHUB_TOKEN\b/,
    /\bOPENAI_API_KEY\b/,
  ]) assert.doesNotMatch(content, forbidden);
});

test("standalone one-click connect and opt-out wrappers use only local bundled source", () => {
  for (const [name,disable] of [
    ["CONNECT-ANY-DEVICE.cmd", false],
    ["DISABLE-ANY-DEVICE-AUTOSTART.cmd", true],
  ]) {
    const cmd = fs.readFileSync("scripts/windows/" + name, "utf8");
    assert.match(cmd, /%~dp0ONE-CLICK-ANY-DEVICE\.ps1/);
    assert.match(cmd, /-NoProfile -STA -ExecutionPolicy RemoteSigned -File/);
    assert.equal(cmd.includes("-DisableAutoStart"), disable);
    assert.doesNotMatch(cmd, /ExecutionPolicy Bypass|schtasks|curl|git clone|token\s*=/i);
  }
});

test(
  "native Windows PowerShell 5: disposable link and foreign-device negative scope",
  { skip: process.platform !== "win32" },
  () => {
    const r = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
      "-File", script, "-SelfTest",
    ], { encoding: "utf8", windowsHide: true, shell: false, timeout: 30000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /KMJ_UNIVERSAL_SELFTEST=PASS/);
    assert.match(r.stdout, /REAL_STARTUP_CHANGED=NO/);
    const blocked = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
      "-File", script, "-AtLogon",
    ], { encoding: "utf8", windowsHide: true, shell: false, timeout: 15000 });
    assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /KMJ_UNIVERSAL=BLOCKED:/);
  },
);
