import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = "scripts/windows/ONE-CLICK-P520-ACTIVATE-20261117.ps1";
const cmdPath = "scripts/windows/ONE-CLICK-P520-ACTIVATE-20261117.cmd";
const verifierPath =
  "scripts/windows/P520-ONE-CLICK-PERSISTENT-HMAC-VERIFY-20261117.mjs";

const source = fs.readFileSync(scriptPath, "utf8");
const cmd = fs.readFileSync(cmdPath, "utf8");
const verifier = fs.readFileSync(verifierPath, "utf8");

test("P520 one-click is fixed device, pinned release and rollback-only task mutation", () => {
  assert.match(source, /DESKTOP-5FVJMET/);
  assert.match(source, /b652b29beafb9b14e42b0078bfb9571fef5b3271/);
  assert.match(source, /TaskState -tasks/);
  assert.match(source, /BACKUP_MANIFEST_NOT_UNIQUE/);
  assert.match(source, /TOKEN_ACL_UNSAFE/);
  assert.match(source, /PROPOSED_DELTA_UNSAFE/);
  assert.match(source, /LIVE_AGENT_NOT_UNIQUE/);
  assert.match(source, /AGENT_TASK_OWNER_MISMATCH/);
  assert.match(source, /PERSISTENT_SUPERVISOR_NOT_UNIQUE/);
  assert.match(source, /Enable-ScheduledTask -TaskName \$TaskName/);
  assert.match(source, /Start-ScheduledTask -TaskName \$TaskName/);
  assert.match(source, /Stop-ScheduledTask -TaskName \$TaskName/);
  assert.match(source, /Disable-ScheduledTask -TaskName \$TaskName/);
  assert.match(source, /P520_ONE_CLICK_AGENT_WIRING' 'PENDING_SEPARATE_GUARDED_HANDOFF'/);
  assert.doesNotMatch(
    source,
    /Stop-Process|Restart-Service|Set-Content|Copy-Item|Move-Item|Remove-Item|Set-Acl|git\s+(reset|clean|checkout)|Invoke-WebRequest|Invoke-RestMethod/,
  );
});

test("P520 CMD runs only owner-reviewed one-click activation, never fresh installation", () => {
  assert.match(cmd, /fltmc >nul 2>&1/);
  assert.match(cmd, /-File "%~dp0ONE-CLICK-P520-ACTIVATE-20261117\.ps1" -Apply/);
  assert.doesNotMatch(
    cmd,
    /install-windows-supervisor|P520-OWNER-DISABLED-RESUME|taskkill|schtasks|npm|git|curl|powershell.*-EncodedCommand/i,
  );
});

test("P520 persistent verifier authenticates without starting a second listener", () => {
  assert.match(verifier, /windowsSupervisorRequest/);
  assert.match(verifier, /config_validate/);
  assert.match(verifier, /activeProcessRuntime\?\.verified !== false/);
  assert.match(verifier, /restart\?\.supported !== false/);
  assert.match(verifier, /update\?\.supported !== false/);
  assert.doesNotMatch(
    verifier,
    /startWindowsSupervisor|runWindowsSupervisorCli|createServer|writeFile|rename|unlink|execFile|spawn\(/,
  );
});

test(
  "P520 PowerShell script parses and isolated negative selftest passes on Windows",
  { skip: process.platform !== "win32" },
  () => {
    const script = path.resolve(scriptPath);
    const parsed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:KMJ_CHECK_SCRIPT,[ref]$t,[ref]$e)|Out-Null;if($e.Count -gt 0){$e|ForEach-Object{Write-Error $_.Message};exit 2}",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, KMJ_CHECK_SCRIPT: script },
      },
    );
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
    const checked = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", script, "-SelfTest"],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.match(checked.stdout, /P520_ONE_CLICK_SELFTEST=PASS/);
  },
);
