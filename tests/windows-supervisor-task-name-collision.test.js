import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const source = fs.readFileSync(
  "scripts/windows/install-windows-supervisor.ps1",
  "utf8",
);

test("supervisor installer must inventory every task namespace without masking lookup failures", () => {
  assert.match(source, /function Assert-NoSupervisorTaskCollision/);
  assert.match(source, /\$allSupervisorTaskNamespaces = @\(Get-ScheduledTask -ErrorAction Stop\)/);
  assert.match(source, /\[string\]\$_\.TaskName -ieq \$TaskName/);
  assert.match(source, /throw 'TASK_ALREADY_EXISTS'/);
  assert.doesNotMatch(
    source,
    /Get-ScheduledTask -TaskName \$TaskName -TaskPath '\\' -ErrorAction SilentlyContinue/,
  );
  const before = source.indexOf("Assert-NoSupervisorTaskCollision -Tasks $allSupervisorTaskNamespaces");
  const register = source.indexOf("Register-ScheduledTask -TaskName");
  assert.ok(before > 0 && before < register);
  // Installation is preparation only: no task start, agent restart, or task replacement.
  assert.doesNotMatch(source, /-Force\s+.*Register-ScheduledTask/);
  assert.doesNotMatch(
    source,
    /Start-ScheduledTask|Enable-ScheduledTask|Restart-Service/,
  );
});

test(
  "real Windows PowerShell refuses foreign-path and root task names, as well as denied inventory",
  { skip: process.platform !== "win32" },
  () => {
    const start = source.indexOf("function Assert-NoSupervisorTaskCollision");
    const end = source.indexOf("\n}\n", start) + 2;
    assert.ok(start > 0 && end > start);
    const helper = source.slice(start, end);
    const script = [
      "$ErrorActionPreference='Stop';",
      "$TaskName='KMJ-CodeBridge-Supervisor-P520';",
      helper,
      "Assert-NoSupervisorTaskCollision -Tasks @();",
      "$foreign=[pscustomobject]@{TaskName=$TaskName;TaskPath='\\Other\\'};",
      "$root=[pscustomobject]@{TaskName=$TaskName;TaskPath='\\'};",
      "$unrelated=[pscustomobject]@{TaskName='Different';TaskPath='\\'};",
      "foreach($task in @($foreign,$root)){",
      "  try { Assert-NoSupervisorTaskCollision -Tasks @($task); throw 'COLLISION_ACCEPTED' }",
      "  catch { if($_.Exception.Message -cne 'TASK_ALREADY_EXISTS'){throw} }",
      "}",
      "Assert-NoSupervisorTaskCollision -Tasks @($unrelated);",
      "Write-Output 'ALL_COLLISION_CASES_PASS';",
    ].join("\n");
    try {
      const result = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { timeout: 20000, stdio: "pipe", encoding: "utf8" },
      );
      assert.match(result, /ALL_COLLISION_CASES_PASS/);
    } catch (error) {
      // Avoid dumping an encoded command or environment in CI diagnostics.
      const receipt = [error?.status, error?.stdout, error?.stderr]
        .map((value) => String(value ?? "").replace(/\s+/g, " ").slice(0, 450))
        .join(" | ");
      throw new Error("WINDOWS_TASK_COLLISION_NATIVE_TEST_FAILED: " + receipt);
    }
  },
);
