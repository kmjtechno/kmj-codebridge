import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const watchdog = "scripts/windows/HOMEOFFICE-RECONNECT-WATCHDOG.ps1";
const oneclick = "scripts/windows/ONE-CLICK-AGENT-AUTOCONNECT.ps1";
const code = fs.readFileSync(watchdog, "utf8");
const existing = fs.readFileSync(oneclick, "utf8");

test("P520 watchdog never creates device identity, credentials, or machine-wide services", () => {
  for (const x of [
    "DESKTOP-5FVJMET",
    "-AtLogon",
    "WATCHDOG_WRONG_HOST",
    "WATCHDOG_ADMIN_NOT_ALLOWED",
    "WATCHDOG_UNTRACKED_SOURCE",
    "WATCHDOG_DIRTY_RUNTIME",
    "WATCHDOG_SHORTCUT_CONFLICT",
    "ALREADY_RUNNING",
    "KMJ_P520_WATCHDOG=INSTALLED_CURRENT_USER_ONLY",
    "REAL_STARTUP_MODIFIED=NO",
    "BEFORE_WINDOWS_LOGIN=NOT_AVAILABLE",
  ]) {
    assert.ok(code.includes(x), "Missing safeguard: " + x);
  }
  assert.match(code, /\[System\.Threading\.Mutex\]::new/);
  assert.match(code, /Start-Sleep -Seconds 180/);
  assert.match(code, /-Device HomeOffice -AtLogon/);
  assert.match(
    code,
    /\[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::Startup\)/,
  );
  for (const forbidden of [
    /Invoke-WebRequest|Invoke-RestMethod|curl\.exe|Start-BitsTransfer/i,
    /Register-ScheduledTask|Enable-ScheduledTask|schtasks|New-Service|Start-Service|Restart-Service/i,
    /git\s+(?:clone|pull|fetch|reset|clean)/i,
    /Copy-Item.*agent\.json|Copy-Item.*enrollment\.json/i,
    /Set-ExecutionPolicy|ExecutionPolicy Bypass|Invoke-Expression/i,
    /PAIR-HOMEOFFICE-CALIBRATION\.ps1|New-LocalUser|Stop-Process/i,
  ]) {
    assert.doesNotMatch(code, forbidden);
  }
});

test("only human-invoked HomeOffice one-click offers watchdog installation", () => {
  assert.match(existing, /\$Device -eq 'HomeOffice' -and !\$AtLogon/);
  assert.match(existing, /HOMEOFFICE-RECONNECT-WATCHDOG\.ps1/);
  assert.match(existing, /AUTOCONNECT_UNTRACKED_WATCHDOG/);
  assert.match(existing, /-File \$watchdog -Install/);
  assert.match(existing, /NOT_INCLUDED_IN_PINNED_RUNTIME/);
  assert.doesNotMatch(existing, /-File \$watchdog -Run/);
});

test(
  "Windows native parser and current-user self-test do not alter real Startup",
  { skip: process.platform !== "win32" },
  () => {
    for (const file of [watchdog, oneclick]) {
      const parser = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path '" +
            file +
            "').Path,[ref]$t,[ref]$e);if(@($e).Count -ne 0){$e|ForEach-Object{Write-Output $_.ErrorId};exit 2}",
        ],
        { encoding: "utf8", timeout: 20000, windowsHide: true },
      );
      assert.equal(parser.status, 0, parser.stdout + parser.stderr);
    }
    const run = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        watchdog,
        "-SelfTest",
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /KMJ_P520_WATCHDOG_SELFTEST=PASS/);
    assert.match(run.stdout, /REAL_STARTUP_MODIFIED=NO/);
  },
);
