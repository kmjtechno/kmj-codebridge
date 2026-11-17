import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const file = "scripts/windows/P520-SUPERVISOR-DISABLED-WITNESS-20261117.ps1";
const source = fs.readFileSync(file, "utf8");

test("P520 stage witness cannot activate, replace, or restart either runtime", () => {
  assert.match(source, /b652b29beafb9b14e42b0078bfb9571fef5b3271/);
  assert.match(source, /Get-ScheduledTask -ErrorAction Stop/);
  assert.match(source, /DISABLED_STAGE_VERIFIED/);
  assert.match(source, /P520_WITNESS_HMAC_AUTHENTICATION' 'NOT_TESTED'/);
  assert.match(source, /P520_WITNESS_ACTIVATION' 'NOT_ATTEMPTED'/);
  assert.match(source, /TASK_ACTION_MISMATCH/);
  assert.match(source, /TOKEN_ACL_UNSAFE/);
  assert.match(source, /CONFIG_BINDING_MISMATCH/);
  assert.match(source, /WRONG_HARDWARE/);
  assert.match(source, /function Task-Class/);
  assert.match(source, /function Private-Acl/);
  assert.doesNotMatch(
    source,
    /Start-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Restart-Service|Stop-Service|Start-Service|Set-Acl|Set-Content|WriteAllText|Invoke-Expression|git reset|git clean|git checkout|git clone/i,
  );
  assert.doesNotMatch(source, /param\s*\(\s*\[switch\]\$Apply/i);
});

test(
  "native Windows parse and negative task-state selftest",
  { skip: process.platform !== "win32" },
  () => {
    const checker = [
      "$ErrorActionPreference='Stop';",
      "$tokens=$null;$errors=$null;",
      "[Management.Automation.Language.Parser]::ParseFile(",
      "'" + file + "',[ref]$tokens,[ref]$errors)|Out-Null;",
      "if($errors.Count){throw ('PARSER:'+",
      "$errors[0].ErrorId+':'+$errors[0].Extent.StartLineNumber)}",
    ].join(" ");
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(checker, "utf16le").toString("base64"),
      ],
      { timeout: 20000 },
    );
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", file, "-SelfTest"],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.match(output, /P520_WITNESS_SELFTEST=PASS/);
    assert.doesNotMatch(output, /P520_WITNESS_RESULT=DISABLED_STAGE_VERIFIED/);
  },
);
