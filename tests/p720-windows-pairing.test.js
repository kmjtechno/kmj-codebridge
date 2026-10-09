import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

test("P720 uses authenticated VPS routes instead of legacy Render gateway", () => {
  assert.match(source, /Confirm-VpsGateway/);
  assert.match(
    source,
    /Invoke-WebRequest -Uri 'https:\/\/kmjtechno\.com\/agent\/health'/,
  );
  assert.match(source, /-ne 401/);
  assert.match(source, /-MaximumRedirection 0 -UseBasicParsing/);
  assert.match(source, /'https:\/\/kmj-codebridge-gateway\.onrender\.com'/);
  assert.match(source, /\$gateway = 'https:\/\/kmjtechno\.com'/);
  assert.match(source, /Unexpected stored gateway origin; refusing migration/);
  assert.match(source, /if \(!\(Test-Path -LiteralPath \$enrollment\)\)/);
  assert.doesNotMatch(source, /https:\/\/kmjtechno\.com\/mcp\/agent/);
});

test("P720 migrates private credentials atomically, stopping scoped agent only", () => {
  assert.match(source, /Find-ScopedAgent/);
  assert.match(source, /Stop-ScopedAgent/);
  assert.match(source, /\.CommandLine\.Contains\(\$configFile\)/);
  assert.match(source, /Multiple P720 agent processes found/);
  assert.match(
    source,
    /Copy-Item -LiteralPath \$configFile -Destination \$backup/,
  );
  assert.match(source, /Protect-File \$backup/);
  assert.match(
    source,
    /\[IO\.File\]::Replace\(\$tempConfig, \$configFile, \$swapBackup\)/,
  );
  assert.match(source, /p720_inference = @\{ command = 'node'/);
  assert.doesNotMatch(
    source,
    /Stop-Process -Name|taskkill \/IM|git reset --hard/,
  );
});

test("P720 validates and clears only its own interrupted migration temp", () => {
  assert.match(source, /Stale private migration file differs from approved scope/);
  assert.match(source, /\$stale\.token -cne \[string\]\$existing\.token/);
  assert.match(source, /Remove-Item -LiteralPath \$tempConfig -Force/);
  assert.match(source, /\$swapBackup = \$configFile \+ '\.swap-'/);
  assert.match(source, /Protect-File \$swapBackup/);
  assert.doesNotMatch(source, /\[IO\.File\]::Replace\(\$tempConfig, \$configFile, \$null\)/);
});

test("Native Windows NTFS File.Replace preserves original in explicit backup", (t) => {
  if (process.platform !== "win32") {
    t.skip("Native Windows NTFS test runs in Windows GitHub CI.");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-p720-ntfs-"));
  const current = path.join(directory, "agent.json");
  const replacement = path.join(directory, "agent.json.migrate");
  const backup = path.join(directory, "agent.json.swap-backup.bak");
  try {
    fs.writeFileSync(current, '{"gateway":"previous"}');
    fs.writeFileSync(replacement, '{"gateway":"vps"}');
    const psString = (s) => "'" + s.replaceAll("'", "''") + "'";
    const command =
      "[IO.File]::Replace(" +
      [replacement, current, backup].map(psString).join(",") +
      ")";
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(current, "utf8")), {
      gateway: "vps",
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), {
      gateway: "previous",
    });
    assert.equal(fs.existsSync(replacement), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
