import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";

const filename = "scripts/windows/P520-OWNER-DISABLED-SUPERVISOR-20261117.ps1";
const source = fs.readFileSync(filename, "utf8");

test("P520 stage is fixed SHA and never takes over a running agent", () => {
  assert.match(source, /b652b29beafb9b14e42b0078bfb9571fef5b3271/);
  assert.match(source, /kmj-kmj-codebridge-desktop-5fvjmet/);
  assert.match(source, /DESKTOP-5FVJMET/);
  assert.match(source, /Get-ScheduledTask -ErrorAction Stop/);
  assert.match(source, /GetOwnerSid/);
  assert.match(source, /OWNER_PROCESS_MISMATCH/);
  assert.match(source, /PINNED_RELEASE_PROVENANCE_FAILED/);
  assert.match(source, /STAGE_ROOT_ACL_UNVERIFIED/);
  assert.match(source, /Assert-NoSupervisorTaskCollision/);
  assert.match(source, /TaskName=\$taskName/);
  assert.match(source, /PREPARED_NOT_ACTIVATED/);
  assert.match(source, /-cne 'Disabled'/);
  assert.match(source, /Mark 'P520_INSTALL_ACTION' 'NONE'/);
  assert.match(source, /if\(\$Apply\)/);
  assert.match(source, /-not \$rootAcl.AreAccessRulesProtected/);
  assert.doesNotMatch(
    source,
    /(?:Start|Restart|Enable|Stop)-ScheduledTask|Restart-Service|Start-Service|Invoke-Expression|git reset|git clean/i,
  );
  assert.doesNotMatch(source, /(?:llama|local-model)-server/i);
  assert.equal((source.match(/if\(\$Apply\) \{/g) || []).length, 1);
  assert.equal(
    (
      source.match(/Mark 'P520_INSTALL_PREFLIGHT' 'BLOCKED_NOT_ATTESTED'/g) ||
      []
    ).length,
    1,
  );
});

test(
  "P520 owner stage native Windows PowerShell parses and isolated selftest passes",
  { skip: process.platform !== "win32" },
  () => {
    const parser = [
      "$ErrorActionPreference='Stop';",
      "$tokens=$null;$parseErrors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "'" + filename + "',[ref]$tokens,[ref]$parseErrors)|Out-Null;",
      "if($parseErrors.Count -ne 0){throw 'P520_SCRIPT_PARSER_FAILED'}",
    ].join(" ");
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", parser],
      {
        timeout: 20000,
        stdio: "pipe",
      },
    );
    const result = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        filename,
        "-SelfTest",
      ],
      { timeout: 20000, encoding: "utf8", stdio: "pipe" },
    );
    assert.match(result, /P520_INSTALL_PREFLIGHT_SELFTEST=PASS/);
    assert.doesNotMatch(
      result,
      /P520_STAGE_PROTECTED_ROOT|P520_STAGE_TASK=DISABLED/,
    );
  },
);
