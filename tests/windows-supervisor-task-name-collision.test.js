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
  assert.match(source, /Get-ScheduledTask -ErrorAction Stop/);
  assert.match(source, /\[string\]\$_\.TaskName -ieq \$TaskName/);
  assert.match(source, /throw 'TASK_ALREADY_EXISTS'/);
  assert.doesNotMatch(
    source,
    /Get-ScheduledTask -TaskName \$TaskName -TaskPath '\\' -ErrorAction SilentlyContinue/,
  );
  const before = source.indexOf("Assert-NoSupervisorTaskCollision\n");
  const register = source.indexOf("Register-ScheduledTask -TaskName");
  assert.ok(before > 0 && before < register);
  // Installation is preparation only: no task start, agent restart, or task replacement.
  assert.doesNotMatch(source, /-Force\s+.*Register-ScheduledTask/);
  assert.doesNotMatch(source, /Start-ScheduledTask|Enable-ScheduledTask|Restart-Service/);
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
      "function Get-ScheduledTask { param($ErrorAction) return @() }",
      "Assert-NoSupervisorTaskCollision;",
      "function Get-ScheduledTask { param($ErrorAction) return @([pscustomobject]@{TaskName=$TaskName; TaskPath='\\Other\\'}) }",
      "try { Assert-NoSupervisorTaskCollision; throw 'COLLISION_ACCEPTED' } catch { if($_.Exception.Message -cne 'TASK_ALREADY_EXISTS'){throw} }",
      "function Get-ScheduledTask { param($ErrorAction) return @([pscustomobject]@{TaskName=$TaskName; TaskPath='\\'}) }",
      "try { Assert-NoSupervisorTaskCollision; throw 'COLLISION_ACCEPTED' } catch { if($_.Exception.Message -cne 'TASK_ALREADY_EXISTS'){throw} }",
      "function Get-ScheduledTask { param($ErrorAction) throw 'INVENTORY_DENIED' }",
      "try { Assert-NoSupervisorTaskCollision; throw 'DENIED_AS_ABSENT' } catch { if($_.Exception.Message -cne 'INVENTORY_DENIED'){throw} }",
    ].join("\n");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 20000,
      stdio: "pipe",
    });
  },
);
