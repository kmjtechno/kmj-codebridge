import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const psPath = path.join(root, "scripts", "setup-p720-codebridge.ps1");
const launcher = fs.readFileSync(
  path.join(root, "scripts", "RUN-P720-CODEBRIDGE-PAIR.cmd"),
  "utf8",
);
const source = fs.readFileSync(psPath, "utf8");

test("P720 pairing stays one-project, free, HTTPS and user scoped", () => {
  assert.match(source, /'D:\\KMJ-HyperSpeed'/);
  assert.match(source, /'kmj-codebridge'/);
  assert.match(source, /license = @\{ mode = 'free' \}/);
  assert.match(source, /'https:\/\/kmjtechno\.com'/);
  assert.match(source, /Protect-File \$configFile/);
  assert.match(source, /Protect-Folder \$private/);
  assert.match(source, /writable = \$true/);
  assert.match(source, /Browser pairing failed or expired/);
  assert.match(source, /Unexpected repository origin/);
  assert.match(source, /no files reset or overwritten/i);
  assert.doesNotMatch(source, /gh auth token|GITHUB_TOKEN|OPENAI_API_KEY|setx |git reset --hard|npm audit fix/);
  assert.match(launcher, /setup-p720-codebridge\.ps1/);
  assert.match(launcher, /%~dp0/);
});

test("P720 Windows PowerShell source parses without execution", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell parser is available on the Windows CI job.");
    return;
  }
  const escaped = psPath.replaceAll("'", "''");
  const cmd = "$tokens=$null;$errs=$null;[System.Management.Automation.Language.Parser]::ParseFile('" +
    escaped +
    "',[ref]$tokens,[ref]$errs) | Out-Null; if($errs.Count -gt 0){ $errs | ForEach-Object {Write-Error $_.Message}; exit 2 }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", cmd], {
    timeout: 15000,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
