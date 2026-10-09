import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(
  root,
  "scripts",
  "p720-guarded-cinecore-refresh.ps1",
);
const script = fs.readFileSync(scriptPath, "utf8");
const launcher = fs.readFileSync(
  path.join(root, "scripts", "START-P720-CINECORE-SAFE-REFRESH.cmd"),
  "utf8",
);

test("Windows refresh stages exact clean main without rewriting CineCore", () => {
  assert.ok(script.includes("projects\\kmj-codebridge"));
  assert.ok(script.includes("projects\\kmj-cinecore"));
  assert.ok(script.includes("runtime\\codebridge-cinecore"));
  assert.match(script, /git\.exe clone -q --no-hardlinks --no-checkout/);
  assert.ok(script.includes("checkout -q --detach $revision"));
  assert.match(script, /CodeBridge checkout has edits; refusing update/);
  assert.match(script, /Staged revision mismatch/);
  assert.ok(launcher.includes("merge --ff-only origin/main"));
  assert.ok(launcher.includes("dirty.Count -ne 0"));
  assert.doesNotMatch(script + launcher, /git\s+reset --hard|git\s+clean -fd/);
});

test("Scope, entitlement, private credential and pinned preflight are preserved", () => {
  assert.ok(script.includes("private\\p720-cinecore"));
  assert.match(script, /Approved one-project CineCore enrollment mismatch/);
  assert.ok(script.includes("@($cfg.projects).Count -ne 1"));
  assert.ok(script.includes("https://kmjtechno.com/"));
  assert.ok(script.includes("ci --ignore-scripts --no-audit --no-fund"));
  assert.ok(script.includes("npm.cmd --prefix $dest run check"));
  assert.ok(script.includes("npm.cmd --prefix $dest test"));
  assert.doesNotMatch(
    script + launcher,
    /enroll-device|OPENAI_API_KEY|ANTHROPIC_API_KEY|--dangerously-skip-permissions/i,
  );
});

test("Exact PID, owned private lock and idle journal are checked before stop", () => {
  assert.match(script, /function Check-Idle/);
  assert.ok(script.includes("state -in @('running','queued','')"));
  assert.match(script, /function Stop-Owned/);
  assert.ok(script.includes("Stop-Owned $candidates[0] $node"));
  assert.match(script, /Agent process and private lock PID disagree/);
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.ok(script.includes("Stop-Process -Id ([int]$proc.ProcessId) -Force"));
  assert.match(script, /function Wait-Connected/);
  assert.match(script, /connection-status\.json/);
  assert.match(script, /observedAt/);
  assert.ok(script.includes("Start-Owned $old $node 'p720-cinecore-rollback'"));
  assert.doesNotMatch(
    script + launcher,
    /Stop-Process -Name|taskkill|Stop-Service|systemctl/,
  );
});

test("Safe report, explicit user action and no token output", () => {
  assert.ok(script.includes("P720-CINECORE-SAFE-REFRESH-RESULT.txt"));
  assert.ok(launcher.includes("P720-CINECORE-SAFE-REFRESH-RESULT.txt"));
  assert.ok(
    launcher.includes("powershell.exe -NoProfile -ExecutionPolicy Bypass"),
  );
  assert.ok(script.includes("Status 'BLOCKED'"));
  assert.ok(script.includes("Status 'PASS'"));
  assert.doesNotMatch(script, /Status .*cfg\.token|Write-Host .*cfg\.token/);
});

test("Windows PowerShell 5.1 parses refresh script without executing it", (t) => {
  if (process.platform !== "win32") {
    t.skip("Native parser runs in Windows CI");
    return;
  }
  const quoted = "'" + scriptPath.replaceAll("'", "''") + "'";
  const command =
    "$tokens=$null;$errors=$null;" +
    "[System.Management.Automation.Language.Parser]::ParseFile(" +
    quoted +
    ",[ref]$tokens,[ref]$errors)|Out-Null;" +
    "if($errors.Count -gt 0){$errors|ForEach-Object{Write-Error $_.Message};exit 2}";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
