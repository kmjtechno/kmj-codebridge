import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ps = path.resolve("scripts/p720-isolated-benchmark.ps1");
const cmd = path.resolve("scripts/RUN-P720-LOCAL-HYPERSPEED.cmd");
const PINNED = "4730f2c619d5e39777cad62a83444e39837412c1";

test("isolated P720 benchmark leaves running agent and main checkout untouched", () => {
  const source = fs.readFileSync(ps, "utf8");
  assert.match(source, new RegExp(PINNED));
  assert.match(source, /git\.exe -C \$repo worktree remove/);
  assert.match(source, /'worktree', 'add', '--detach'/);
  assert.match(source, /'fetch', '--no-tags', 'origin', 'main'/);
  assert.match(source, /merge-base --is-ancestor \$pinned \$remoteHead/);
  assert.match(source, /UNTRUSTED_GITHUB_ORIGIN/);
  assert.match(source, /LIVE_WORKTREE_UNCHANGED=PASS/);
  assert.match(source, /scripts\\p720-local-benchmark\.mjs/);
  assert.match(source, /NODE24_REQUIRED/);
  for (const unsafe of [
    /git\s+(?:reset|pull|push|checkout|clean)/i,
    /--force/i,
    /Stop-Process/i,
    /Remove-Item/i,
    /Set-Content/i,
    /Start-Service/i,
    /agent\.json|enrollment\.json/i,
    /curl|Invoke-WebRequest|Invoke-RestMethod/i,
  ]) {
    assert.doesNotMatch(source, unsafe);
  }
});

test("one-click launcher invokes only the reviewed sibling script", () => {
  const source = fs.readFileSync(cmd, "utf8");
  assert.match(source, /%~dp0p720-isolated-benchmark\.ps1/);
  assert.match(source, /-NoProfile -NonInteractive/);
  assert.match(source, /BENCH_EXIT_CODE/);
  assert.doesNotMatch(source, /git\s+|npm install|ollama pull|sc\.exe/i);
});

test(
  "PowerShell launcher source parses on Windows without executing the benchmark",
  { skip: process.platform !== "win32" },
  () => {
    const quotedPath = ps.replaceAll("'", "''");
    const statement = [
      "$tokens=$null",
      "$errors=$null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${quotedPath}',[ref]$tokens,[ref]$errors)|Out-Null`,
      "if($errors.Count -gt 0){exit 2}",
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", statement],
      {
        shell: false,
        timeout: 10000,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, "PowerShell AST must parse");
  },
);
