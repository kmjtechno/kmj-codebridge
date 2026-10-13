import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const updaterPath = path.resolve("scripts/p720-native-agent-update.ps1");
const launcherPath = path.resolve("scripts/UPDATE-P720-CODEBRIDGE.cmd");
const PINNED = "ff0afff981c3e0621b6c6d1e355e66a511c8720b";

test("native updater is an opt-in SHA-pinned, scoped and rollback-guarded agent switch", () => {
  const source = fs.readFileSync(updaterPath, "utf8");
  assert.match(source, /ValidatePattern\('\^\[a-f0-9\]\{40\}\$'\)/);
  assert.match(source, /'UNTRUSTED_SOURCE_REMOTE'/);
  assert.match(source, /AllowTrackedDirtyCheckout/);
  assert.match(source, /function SnapshotTrackedChanges/);
  assert.match(source, /function AssertCheckoutUnchanged/);
  assert.match(source, /'LIVE_CHECKOUT_UNSUPPORTED_CHANGE'/);
  assert.match(source, /'LIVE_CHECKOUT_UNTRUSTED_PATH'/);
  assert.match(source, /'LIVE_CHECKOUT_BYTES_CHANGED'/);
  assert.match(
    source,
    /Get-FileHash -LiteralPath \$fullPath -Algorithm SHA256/,
  );
  assert.match(
    source,
    /\$snapshot\.ModifiedCount -gt 0 -and !\$AllowTrackedDirtyCheckout/,
  );
  assert.match(source, /AssertCheckoutUnchanged\s+AssertIdle/);
  assert.match(source, /merge-base --is-ancestor \$TargetSha \$remote/);
  assert.match(source, /merge-base --is-ancestor \$initialHead \$TargetSha/);
  assert.match(source, /'worktree', 'add', '--detach'/);
  assert.match(
    source,
    /npm\.cmd --prefix \$release ci --include=dev --ignore-scripts/,
  );
  assert.match(source, /npm\.cmd --prefix \$release run check/);
  assert.match(source, /npm\.cmd --prefix \$release test/);
  assert.match(source, /npm\.cmd --prefix \$release run scan:secrets/);
  assert.match(source, /ACTIVE_WORK_REQUIRES_DRAIN/);
  assert.match(source, /ACTIVE_AUTOPILOT_LEASE/);
  assert.match(source, /SCOPED_AGENT_CHANGED_DURING_STAGING/);
  assert.match(source, /PRIVATE_CONFIG_CHANGED_DURING_STAGING/);
  assert.match(source, /OLD_AGENT_NOT_STOPPED/);
  assert.match(source, /NEW_AGENT_HEARTBEAT_NOT_VERIFIED/);
  assert.match(source, /ROLLBACK_HEARTBEAT_FAILED/);
  assert.match(source, /ORIGINAL_CHECKOUT_UNCHANGED=PASS/);
  assert.match(source, /ENROLLMENT_CONFIG_UNCHANGED=PASS/);
  assert.match(source, /CODEBRIDGE_GATEWAY|expectedGateway/);
  for (const forbidden of [
    /git\s+(?:reset|pull|clean|push)/i,
    /--force/i,
    /Start-Service/i,
    /Set-Content/i,
    /Remove-Item/i,
    /New-LocalUser/i,
    /Invoke-Expression/i,
    /DownloadFile/i,
    /ollama\s+pull/i,
    /mcp__GitHub__/i,
    /Remove-Job/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("native updater accepts the original approved pairing gateway slash without weakening scope", () => {
  const source = fs.readFileSync(updaterPath, "utf8");
  const pairing = fs.readFileSync(
    path.resolve("scripts/setup-p720-codebridge.ps1"),
    "utf8",
  );
  assert.match(pairing, /gateway = \$gateway\.TrimEnd\('\/'\) \+ '\/'/);
  assert.match(source, /function AssertApprovedGateway/);
  assert.match(
    source,
    /\$value -cnotin @\(\$expectedGateway, \(\$expectedGateway \+ '\/'\)\)/,
  );
  assert.match(source, /AssertApprovedGateway \(\[string\]\$cfg\.gateway\)/);
  assert.match(source, /'AGENT_GATEWAY_NOT_APPROVED'/);
  assert.match(source, /@\(\$cfg\.projects\)\.Count -ne 1/);
  assert.match(source, /\[string\]\$cfg\.projects\[0\]\.root -ne \$repo/);
  assert.match(source, /\[string\]\$cfg\.stateDir -ne \$statePath/);
  assert.match(source, /\[string\]\$cfg\.token -eq ''/);
});

test(
  "Windows PowerShell preflight approves exactly the two canonical gateway spellings",
  { skip: process.platform !== "win32" },
  () => {
    const source = fs.readFileSync(updaterPath, "utf8");
    const match = source.match(
      /function AssertApprovedGateway\(\[string\]\$value\) \{[\s\S]*?\n\}/,
    );
    assert.ok(match, "gateway validation function must be present");
    const code = [
      "$ErrorActionPreference = 'Stop'",
      "$expectedGateway = 'https://kmjtechno.com'",
      match[0],
      "foreach ($url in @('https://kmjtechno.com', 'https://kmjtechno.com/')) { AssertApprovedGateway $url }",
      "foreach ($url in @('https://kmj-codebridge-gateway.onrender.com/', 'https://kmjtechno.com/agent/poll', 'https://kmjtechno.com/?token=x', 'http://kmjtechno.com/', 'https://evil.example/')) {",
      "  $blocked = $false",
      "  try { AssertApprovedGateway $url } catch { if ($_.Exception.Message -eq 'AGENT_GATEWAY_NOT_APPROVED') { $blocked = $true } else { throw } }",
      "  if (!$blocked) { throw 'UNAPPROVED_GATEWAY_ACCEPTED' }",
      "}",
      "Write-Output 'P720_GATEWAY_VALIDATION=PASS'",
    ].join("\n");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", code],
      { shell: false, timeout: 10000, windowsHide: true, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /P720_GATEWAY_VALIDATION=PASS/);
  },
);

test(
  "Windows PowerShell 5 Git fetch tolerates benign stderr but rejects nonzero exit",
  { skip: process.platform !== "win32" },
  (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p720-git-stderr-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const bare = path.join(temp, "remote.git");
    const writer = path.join(temp, "writer");
    const consumer = path.join(temp, "consumer");
    const git = (args) => {
      const result = spawnSync("git", args, {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(["init", "--bare", "-b", "main", bare]);
    git(["init", "-b", "main", writer]);
    const commitArgs = [
      "-C",
      writer,
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "--allow-empty",
    ];
    git([...commitArgs, "-m", "first"]);
    git(["-C", writer, "remote", "add", "origin", bare]);
    git(["-C", writer, "push", "-u", "origin", "main"]);
    git(["clone", "--branch", "main", bare, consumer]);
    git([...commitArgs, "-m", "second"]);
    git(["-C", writer, "push", "origin", "main"]);
    const expected = git(["-C", writer, "rev-parse", "HEAD"]);
    const source = fs.readFileSync(updaterPath, "utf8");
    const match = source.match(
      /function Git\(\[string\[\]\]\$GitArgs\) \{[\s\S]*?\n\}/,
    );
    assert.ok(match, "the guarded native Git wrapper must be present");
    const quoted = consumer.replaceAll("'", "''");
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `$repo = '${quoted}'`,
      `$expected = '${expected}'`,
      match[0],
      "$null = Git -GitArgs @('fetch', '--no-tags', 'origin', 'main')",
      "$fetched = [string]((Git -GitArgs @('rev-parse', '--verify', 'FETCH_HEAD')) | Select-Object -First 1)",
      "if ($fetched -cne $expected) { throw 'FETCH_HEAD_MISMATCH' }",
      "try { $null = Git -GitArgs @('rev-parse', '--verify', 'not-a-real-ref'); throw 'GIT_FAILURE_NOT_DETECTED' } catch {",
      "  if ($_.Exception.Message -cne 'GIT_OPERATION_FAILED') { throw }",
      "}",
      "if ($ErrorActionPreference -cne 'Stop') { throw 'ERROR_PREFERENCE_CHANGED' }",
      "Write-Output 'GIT_STDERR_EXITCODE=PASS'",
    ].join("\n");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { shell: false, windowsHide: true, timeout: 30000, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /GIT_STDERR_EXITCODE=PASS/);
  },
);

test(
  "Windows PowerShell 5 binds heartbeat processId without touching automatic PID",
  { skip: process.platform !== "win32" },
  () => {
    const source = fs.readFileSync(updaterPath, "utf8");
    const match = source.match(
      /function ConfirmRuntime\(\[int\]\$processId, \[string\]\$entry, \[datetime\]\$since\) \{[\s\S]*?\n\}/,
    );
    assert.ok(match, "real heartbeat verifier must be available");
    assert.doesNotMatch(match[0], /\$pid\b/i);
    const code = [
      "$ErrorActionPreference = 'Stop'",
      "$savedPid = $PID",
      match[0],
      "if (ConfirmRuntime -processId 2147483000 -entry 'none' -since ([datetime]::UtcNow)) { throw 'UNEXPECTED_HEARTBEAT' }",
      "if ($PID -ne $savedPid) { throw 'AUTOMATIC_PID_MUTATED' }",
      "Write-Output 'RUNTIME_PID_BINDING=PASS'",
    ].join("\n");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", code],
      { shell: false, timeout: 15000, windowsHide: true, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RUNTIME_PID_BINDING=PASS/);
  },
);

test("one-click native launch requires pinned known reviewed SHA and sibling script", () => {
  const source = fs.readFileSync(launcherPath, "utf8");
  assert.match(source, new RegExp(PINNED));
  assert.match(source, /%~dp0p720-native-agent-update\.ps1/);
  assert.match(source, /-NoProfile -NonInteractive/);
  assert.match(source, /CODEBRIDGE_UPDATE_EXIT/);
  assert.match(source, /-AllowTrackedDirtyCheckout/);
  assert.match(
    source,
    /Tracked-only unstaged edits are fingerprinted and preserved/,
  );
  assert.doesNotMatch(
    source,
    /git\s+reset|curl|ollama pull|npm install|sc\.exe/i,
  );
});

test(
  "Windows PowerShell 5 source parses without running any upgrade or touching services",
  { skip: process.platform !== "win32" },
  () => {
    const quoted = updaterPath.replaceAll("'", "''");
    const command = [
      "$tokens=$null",
      "$errors=$null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${quoted}',[ref]$tokens,[ref]$errors)|Out-Null`,
      "if($errors.Count){Write-Output ($errors|Out-String);exit 2}",
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { shell: false, timeout: 10000, windowsHide: true, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);
