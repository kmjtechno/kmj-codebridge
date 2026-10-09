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
  assert.doesNotMatch(
    source,
    /gh auth token|GITHUB_TOKEN|OPENAI_API_KEY|setx |git reset --hard|npm audit fix/,
  );
  assert.match(launcher, /setup-p720-codebridge\.ps1/);
  assert.match(launcher, /%~dp0/);
});

test("P720 Windows PowerShell source parses without execution", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell parser is available on the Windows CI job.");
    return;
  }
  const escaped = psPath.replaceAll("'", "''");
  const cmd =
    "$tokens=$null;$errs=$null;[System.Management.Automation.Language.Parser]::ParseFile('" +
    escaped +
    "',[ref]$tokens,[ref]$errs) | Out-Null; if($errs.Count -gt 0){ $errs | ForEach-Object {Write-Error $_.Message}; exit 2 }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", cmd], {
    timeout: 15000,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("P720 standalone launcher fetches trusted main without destructive reset", () => {
  const bootstrap = fs.readFileSync(
    path.join(root, "scripts", "START-P720-ONECLICK.cmd"),
    "utf8",
  );
  assert.match(bootstrap, /fetch origin main/);
  assert.match(bootstrap, /merge --ff-only origin\/main/);
  assert.match(bootstrap, /Untrusted Git remote/);
  assert.match(bootstrap, /Dirty checkout: no reset attempted/);
  assert.match(bootstrap, /setup-p720-codebridge\.ps1/);
  assert.doesNotMatch(
    bootstrap,
    /git reset --hard|git clean -fd|gh auth token/,
  );
});

test("P720 reuses approved legacy enrollment with verified production gateway", () => {
  assert.match(source, /IsNullOrWhiteSpace\(\$gateway\)/);
  assert.match(source, /https:\/\/kmj-codebridge-gateway\.onrender\.com/);
  assert.match(source, /Invoke-WebRequest -Uri \(\$gateway \+ '\/healthz'\)/);
  assert.match(source, /-MaximumRedirection 0 -UseBasicParsing/);
  assert.match(source, /retained existing enrollment for retry/);
  assert.match(
    source,
    /Approved enrollment gateway must be a canonical HTTPS origin/,
  );
  assert.match(source, /if \(!\(Test-Path -LiteralPath \$enrollment\)\)/);
  assert.doesNotMatch(source, /https:\/\/kmjtechno\.com\/mcp\/agent/);
});
