import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(base, "scripts", "setup-p720-cinecore.ps1");
const source = fs.readFileSync(sourcePath, "utf8");
const launcher = fs.readFileSync(
  path.join(base, "scripts", "START-P720-CINECORE-CLAUDE.cmd"),
  "utf8",
);

test("CineCore pairing uses distinct approved device, tenant and project", () => {
  assert.match(source, /'kmj-p720-cinecore-'/);
  assert.match(source, /\$projectId = 'kmj-cinecore'/);
  assert.match(source, /'projects\\kmj-cinecore'/);
  assert.match(source, /'private\\p720-cinecore'/);
  assert.match(source, /'enrollment\.json'/);
  assert.match(source, /'kmj-codebridge'/);
  assert.match(source, /CineCore pairing identity\/project grant did not match exactly/);
  assert.ok(source.includes("@($grant.projects).Count -ne 1"));
  assert.match(source, /'read', 'write', 'execute'/);
  assert.match(source, /license = @\{ mode = 'free' \}/);
});

test("CineCore gateway fails closed and never forwards token to unknown host", () => {
  assert.match(source, /Test-VpsGateway/);
  assert.match(source, /https:\/\/kmjtechno\.com\/agent\/health/);
  assert.match(source, /Status 'PASS' 'VPS agent gateway HTTPS\/authentication probe HTTP 401\.'/);
  assert.match(source, /Unexpected enrollment gateway; refusing forwarding of device token/);
  assert.match(source, /gateway = 'https:\/\/kmjtechno\.com\/'/);
  assert.match(source, /Protect-Folder \$private/);
  assert.match(source, /Protect-File \$config/);
  assert.doesNotMatch(source, /git reset --hard|gh auth token|taskkill\s+\/F|OPENAI_API_KEY/);
});

test("CineCore build gates are fixed-argument and project-scoped", () => {
  assert.match(source, /cinecore_configure = @\{ command = 'cmake'/);
  assert.match(source, /cinecore_build = @\{ command = 'cmake'/);
  assert.match(source, /cinecore_ctest = @\{ command = 'ctest'/);
  assert.match(source, /'Visual Studio 17 2022'/);
  assert.match(source, /'Release'/);
  assert.match(source, /'--output-on-failure'/);
  assert.match(source, /writable = \$true/);
  assert.doesNotMatch(source, /command = '(powershell|cmd|bash|sh)'/);
});

test("Claude Code registration is project-local, OAuth, no static credential", () => {
  assert.match(source, /Configure-ClaudeMcp/);
  assert.match(source, /Push-Location -LiteralPath \$cinecore/);
  assert.match(source, /mcp add --transport http --scope local kmj-codebridge-cinecore https:\/\/kmjtechno\.com\/mcp/);
  assert.match(source, /OAuth sign-in still required/);
  assert.doesNotMatch(source, /claude mcp add.*--header|claude.*--dangerously-skip-permissions/);
});

test("CineCore standalone launcher fetches clean CodeBridge main only", () => {
  assert.match(launcher, /git -C \$r fetch origin main/);
  assert.match(launcher, /git -C \$r merge --ff-only origin\/main/);
  assert.match(launcher, /CodeBridge checkout dirty: no files reset/);
  assert.match(launcher, /setup-p720-cinecore\.ps1/);
  assert.doesNotMatch(launcher, /git clean -fd|git reset --hard|del \/s/);
});

test("Windows PowerShell CineCore setup parses without executing", (t) => {
  if (process.platform !== "win32") {
    t.skip("Native Windows parser runs in Windows CI.");
    return;
  }
  const escaped = sourcePath.replaceAll("'", "''");
  const program =
    "$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('" +
    escaped +
    "',[ref]$tokens,[ref]$errors) | Out-Null;if($errors.Count -gt 0){$errors|ForEach-Object{Write-Error $_.Message};exit 2}";
  const res = spawnSync("powershell.exe", ["-NoProfile", "-Command", program], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});
