import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ps = fs.readFileSync(
  path.join(root, "scripts/p720-cinecore-reconnect.ps1"),
  "utf8",
);
const cmd = fs.readFileSync(
  path.join(root, "scripts/START-P720-CINECORE-RECONNECT.cmd"),
  "utf8",
);

test("CineCore reconnect is only for an existing dedicated enrollment", () => {
  for (const required of [
    "CINECORE_ENROLLMENT_MISSING_USE_APPROVED_SETUP",
    "EXISTING_AGENT_SCOPE_INVALID",
    "MULTIPLE_SCOPED_AGENTS_BLOCKED",
    "Verify-Origin $repo 'kmj-codebridge'",
    "Verify-Origin $project 'kmj-cinecore'",
    "https://kmjtechno.com/",
    "Start-Process -FilePath $node",
    "Fresh-Connection $since",
    "NOT_VERIFIED_CHECK_CODEBRIDGE_CONNECTION_OVERVIEW",
  ]) {
    assert.ok(ps.includes(required), required);
  }
  for (const disallowed of [
    /git\s+-C[^\n]+(?:reset|checkout|merge|fetch|pull)/i,
    /Stop-Process/,
    /Remove-Item/,
    /enroll-device\.js/,
    /npm(?:\.cmd)?\s+(?:ci|install)/,
    /icacls\.exe/,
    /Write-Host\s+.*(?:token|enrollment|secret)/i,
  ]) {
    assert.doesNotMatch(ps, disallowed);
  }
  assert.match(cmd, /p720-cinecore-reconnect\.ps1/);
});

test(
  "Windows PowerShell parses the reconnect launcher without executing it",
  { skip: process.platform !== "win32" },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const file = path.join(root, "scripts/p720-cinecore-reconnect.ps1");
    const command = [
      "$tokens=$null;$errors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "$args[0],[ref]$tokens,[ref]$errors) | Out-Null;",
      "if($errors.Count){$errors | ForEach-Object {Write-Error $_}; exit 2};",
      "exit 0",
    ].join("");
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
      file,
    ]);
  },
);
