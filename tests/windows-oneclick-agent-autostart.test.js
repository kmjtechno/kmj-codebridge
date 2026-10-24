import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const autoPath = path.resolve(
  "scripts/windows/ONE-CLICK-AGENT-AUTOCONNECT.ps1",
);
const code = fs.readFileSync(autoPath, "utf8");

test("one-click installer only reconnects known approved Windows devices", () => {
  for (const tag of [
    "ValidateSet('HomeOffice','P720')",
    "DESKTOP-5FVJMET",
    "DESKTOP-K3AHHEM",
    "CONNECT-CALIBRATION-PRO.ps1",
    "CONNECT-P720-CODEBRIDGE.ps1",
    "PAIR-HOMEOFFICE-CALIBRATION.ps1",
    "AUTOCONNECT_EXISTING_P720_TASK_REVIEW_REQUIRED",
    "AUTOCONNECT_WRONG_WINDOWS_DEVICE",
    "AUTOCONNECT_UNTRUSTED_CODEBRIDGE_ORIGIN",
    "AUTOCONNECT_RUNTIME_TRACKED_CHANGES",
    "AUTOCONNECT_STARTUP_SHORTCUT_CONFLICT",
    "AUTOCONNECT_SCOPED_RECONNECT_NOT_VERIFIED",
    "VERIFY_WITH_AUTHENTICATED_CODEBRIDGE_CLIENT",
  ]) {
    assert.ok(code.includes(tag), "Missing safety check: " + tag);
  }
  assert.match(code, /\$AtLogon/);
  assert.match(code, /\$RemoveAutoStart/);
  assert.match(code, /-AutoDiscover','-NoPicker/);
  assert.match(code, /if \(\$outcome.ExitCode -ne 0\)/);
  assert.match(code, /\$pair = Join-Path \$PSScriptRoot \$pairName/);
  assert.match(code, /\$prior.State -ne 'Disabled'/);
  assert.match(code, /\$existing = Test-Path -LiteralPath \$shortcutPath/);
  assert.match(code, /VerifyShortcut \$link \$ps \$arguments \$repo/);
  assert.match(code, /-AtLogon'/);
  assert.match(code, /StartUp|Startup/i);
  assert.match(code, /OTHER_WINDOWS_AGENTS=UNTOUCHED/);
  assert.doesNotMatch(
    code,
    /\b(?:Register-ScheduledTask|Enable-ScheduledTask|Start-ScheduledTask|Stop-Process|Restart-Service|Set-Service|Set-Content|Invoke-Expression|New-LocalUser|Set-Date)\b/i,
  );
  assert.doesNotMatch(
    code,
    /\b(?:GITHUB_TOKEN|OPENAI_API_KEY|Copy-Item|git\s+reset|git\s+clean|git\s+pull)\b/i,
  );
});

test("startup launcher is opt-in, noninteractive on logon, exact-scoped, and reversible", () => {
  assert.match(code, /\[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::Startup\)/);
  assert.match(code, /New-Object -ComObject WScript.Shell/);
  assert.match(code, /-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File/);
  assert.match(code, /if \(\$AtLogon\) \{/);
  assert.match(code, /if \(\$RemoveAutoStart\) \{/);
  assert.match(code, /Remove-Item -LiteralPath \$shortcutPath/);
  for (const [name, scope, disable] of [
    ["ONE-CLICK-HOMEOFFICE-CONNECT.cmd", "HomeOffice", false],
    ["ONE-CLICK-P720-CONNECT.cmd", "P720", false],
    ["DISABLE-HOMEOFFICE-AUTOCONNECT.cmd", "HomeOffice", true],
    ["DISABLE-P720-AUTOCONNECT.cmd", "P720", true],
  ]) {
    const cmd = fs.readFileSync("scripts/windows/" + name, "utf8");
    assert.match(cmd, /%~dp0ONE-CLICK-AGENT-AUTOCONNECT\.ps1/);
    assert.match(cmd, new RegExp("-Device " + scope + "\\b"));
    assert.equal(cmd.includes("-RemoveAutoStart"), disable);
    assert.doesNotMatch(cmd, /ExecutionPolicy Bypass|schtasks|curl|git clone|token\s*=/i);
  }
  const reconnect = fs.readFileSync(
    "scripts/windows/CONNECT-CALIBRATION-PRO.ps1",
    "utf8",
  );
  assert.match(reconnect, /\[switch\]\$NoPicker/);
  assert.match(reconnect, /if \(\[string\]::IsNullOrWhiteSpace\(\$ConfigPath\) -and \$NoPicker\)/);
  assert.match(reconnect, /SCOPED_ENROLLMENT_NOT_FOUND_NONINTERACTIVE/);
});

test(
  "Windows native COM shortcut selftest and wrong-machine denial do not register real startup",
  { skip: process.platform !== "win32" },
  () => {
    for (const scope of ["HomeOffice", "P720"]) {
      const testRun = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "RemoteSigned",
          "-File",
          autoPath,
          "-Device",
          scope,
          "-SelfTest",
        ],
        { shell: false, windowsHide: true, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(testRun.status, 0, testRun.stdout + testRun.stderr);
      assert.match(testRun.stdout, /KMJ_AUTOCONNECT_SELFTEST=PASS/);
      assert.match(testRun.stdout, /REAL_STARTUP_MODIFIED=NO/);
    }
    const denied = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        autoPath,
        "-Device",
        "HomeOffice",
        "-AtLogon",
      ],
      { shell: false, windowsHide: true, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(denied.status, 2, denied.stdout + denied.stderr);
    assert.match(denied.stdout, /KMJ_AUTOCONNECT=BLOCKED:AUTOCONNECT_WRONG_WINDOWS_DEVICE/);
  },
);
