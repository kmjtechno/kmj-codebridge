import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const file = "scripts/windows/P520-OWNER-DISABLED-RESUME-20261117.ps1";
const source = fs.readFileSync(file, "utf8");

test("P520 resume reuses exact release and refuses unsafe partial installations", () => {
  assert.match(source, /b652b29beafb9b14e42b0078bfb9571fef5b3271/);
  assert.match(source, /P520_RELEASE_PROVENANCE_MISMATCH/);
  assert.match(source, /P520_RELEASE_NOT_CLEAN/);
  assert.match(source, /P520_DEPENDENCIES_NOT_INSTALLED/);
  assert.match(source, /P520_EXISTING_BACKUP_REVIEW_REQUIRED/);
  assert.match(source, /P520_PROPOSED_RACE/);
  assert.match(source, /P520_LIVE_OWNER_MISMATCH/);
  assert.match(source, /P520_STAGE_ACL_UNTRUSTED/);
  assert.match(source, /Get-ScheduledTask -ErrorAction Stop/);
  assert.match(source, /-cne 'Disabled'/);
  assert.match(source, /PREPARED_NOT_ACTIVATED/);
  assert.match(source, /DRY_RUN_PASS_NO_CHANGES/);
  assert.match(source, /if\(-not \$Apply\)/);
  assert.doesNotMatch(source, /git clone|checkout --detach|git reset|git clean/i);
  assert.doesNotMatch(
    source,
    /Start-ScheduledTask|Enable-ScheduledTask|Restart-Service|Start-Service|Invoke-Expression/,
  );
  assert.equal((source.match(/function Candidate-Identity/g) || []).length, 1);
  assert.equal((source.match(/P520_RESUME_RESULT' 'PREPARED_NOT_ACTIVATED'/g) || []).length, 1);
});

test(
  "native Windows PowerShell parses and selftests the bounded resume",
  { skip: process.platform !== "win32" },
  () => {
    const ps = [
      "$ErrorActionPreference='Stop';",
      "$tokens=$null;$issues=$null;",
      "[Management.Automation.Language.Parser]::ParseFile(",
      "'" + file + "',[ref]$tokens,[ref]$issues)|Out-Null;",
      "if($issues.Count){",
      "$first=$issues[0];throw ('PARSER:'+",
      "$first.ErrorId+':'+$first.Extent.StartLineNumber)}",
    ].join(" ");
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ]);
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", file, "-SelfTest"],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.match(output, /P520_INSTALL_PREFLIGHT_SELFTEST=PASS/);
    assert.doesNotMatch(output, /P520_RESUME_TASK=DISABLED/);
  },
);
