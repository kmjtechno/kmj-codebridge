import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const updaterPath = path.resolve("scripts/p720-native-agent-update.ps1");
const launcherPath = path.resolve("scripts/UPDATE-P720-CODEBRIDGE.cmd");
const PINNED = "7a45309fb81ea955d3acc85d03f1b1bb331d0795";

test("native updater is an opt-in SHA-pinned, scoped and rollback-guarded agent switch", () => {
  const source = fs.readFileSync(updaterPath, "utf8");
  assert.match(source, /ValidatePattern\('\^\[a-f0-9\]\{40\}\$'\)/);
  assert.match(source, /'UNTRUSTED_SOURCE_REMOTE'/);
  assert.match(source, /AllowTrackedDirtyCheckout/);
  assert.match(source, /AllowUntrackedFiles/);
  assert.match(source, /LIVE_CHECKOUT_UNTRACKED_APPROVAL_REQUIRED/);
  assert.match(source, /LIVE_CHECKOUT_UNTRACKED_FILE_TOO_LARGE/);
  assert.match(source, /UntrackedCount = \$untrackedCount/);
  assert.match(
    source,
    /\$snapshot\.UntrackedCount -gt 0 -and !\$AllowUntrackedFiles/,
  );
  assert.match(source, /function SnapshotTrackedChanges/);
  assert.match(source, /function AssertCheckoutUnchanged/);
  assert.match(source, /'LIVE_CHECKOUT_UNSUPPORTED_CHANGE'/);
  assert.match(source, /'LIVE_CHECKOUT_UNTRUSTED_PATH'/);
  assert.match(source, /'LIVE_CHECKOUT_BYTES_CHANGED'/);
  assert.match(source, /FileSha256 -Path \$fullPath/);
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
      // This checks native parameter binding, not CIM/WMI responsiveness.
      // Run the real verifier with a deterministic missing-process boundary.
      "$script:observedProcessFilter = $null",
      "function Start-Sleep { param([int]$Seconds) }",
      "function Get-CimInstance { param([string]$ClassName, [string]$Filter); $script:observedProcessFilter = $Filter; return $null }",
      match[0],
      "if (ConfirmRuntime -processId 2147483000 -entry 'none' -since ([datetime]::UtcNow)) { throw 'UNEXPECTED_HEARTBEAT' }",
      "if ($script:observedProcessFilter -cne 'ProcessId = 2147483000') { throw 'PROCESS_ID_NOT_FORWARDED' }",
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

test(
  "P720 dirty snapshot hashes regular untracked files and detects mutation without running an updater",
  { skip: process.platform !== "win32" },
  (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p720-untracked-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const repo = path.join(temp, "repo");
    fs.mkdirSync(repo);
    const git = (args) => {
      const result = spawnSync("git", ["-C", repo, ...args], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 12000,
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(["init", "-q"]);
    fs.writeFileSync(path.join(repo, "README.md"), "baseline\\n");
    git(["add", "README.md"]);
    git([
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      "baseline",
    ]);
    fs.writeFileSync(path.join(repo, "README.md"), "modified\\n");
    fs.mkdirSync(path.join(repo, "docs"));
    fs.writeFileSync(
      path.join(repo, "docs", "plan.md"),
      "KEEP PRIVATE DRAFT\\n",
    );
    const source = fs.readFileSync(updaterPath, "utf8");
    const match = source.match(
      /function SnapshotTrackedChanges \{[\s\S]*?\n\}/,
    );
    const helper = source.match(
      /function FileSha256\(\[string\]\$Path\) \{[\s\S]*?\n\}/,
    );
    assert.ok(match);
    assert.ok(helper);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$repo = '" + repo.replaceAll("'", "''") + "'",
      helper[0],
      match[0],
      "$first = SnapshotTrackedChanges",
      "if ($first.ModifiedCount -ne 1 -or $first.UntrackedCount -ne 1) { throw 'BAD_COUNTS' }",
      "Add-Content -LiteralPath (Join-Path $repo 'docs\\plan.md') -Value 'another line'",
      "$second = SnapshotTrackedChanges",
      "if ($first.Digests -ceq $second.Digests) { throw 'MUTATION_UNDETECTED' }",
      "if ($first.Status -cne $second.Status) { throw 'UNEXPECTED_GIT_STATUS' }",
      "Write-Output 'UNTRACKED_HASH_PRESERVATION=PASS'",
    ].join("\n");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { shell: false, windowsHide: true, encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /UNTRACKED_HASH_PRESERVATION=PASS/);
  },
);

test("managed release update is verified and rollback targets actual prior source", () => {
  const source = fs.readFileSync(updaterPath, "utf8");
  assert.match(source, /function ResolvePreviousAgentSource/);
  assert.match(source, /EXISTING_AGENT_RELEASE_GIT_UNTRUSTED/);
  assert.match(source, /EXISTING_AGENT_RELEASE_SHA_MISMATCH/);
  assert.match(source, /PREVIOUS_RELEASE_NOT_ANCESTOR/);
  assert.match(
    source,
    /StartScoped \$oldEntry \$oldWorkDir 'rollback-previous'/,
  );
  assert.match(source, /ROLLBACK_SOURCE=PREVIOUS_VERIFIED_AGENT_RUNTIME/);
  assert.doesNotMatch(
    source,
    /StartScoped \$oldEntry \$repo 'rollback-original'/,
  );
});

test(
  "Windows accepts only a Git-verified prior release without running the agent updater",
  { skip: process.platform !== "win32" },
  (t) => {
    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), "p720-managed-release-"),
    );
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const repo = path.join(temp, "project");
    const releases = path.join(temp, "codebridge-releases");
    fs.mkdirSync(repo);
    fs.mkdirSync(releases);
    const git = (...args) => {
      const r = spawnSync("git", args, {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git("-C", repo, "init", "-q");
    git("-C", repo, "config", "user.name", "CI");
    git("-C", repo, "config", "user.email", "ci@example.invalid");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "cli.js"), "export {};\n");
    git("-C", repo, "add", ".");
    git("-C", repo, "commit", "-qm", "prior");
    const oldSha = git("-C", repo, "rev-parse", "HEAD");
    const oldDir = path.join(releases, oldSha);
    git("-C", repo, "worktree", "add", "--detach", oldDir, oldSha);
    fs.writeFileSync(path.join(repo, "next.txt"), "next\n");
    git("-C", repo, "add", ".");
    git("-C", repo, "commit", "-qm", "current");
    const target = git("-C", repo, "rev-parse", "HEAD");
    const helper = fs
      .readFileSync(updaterPath, "utf8")
      .match(
        /function ResolvePreviousAgentSource\(\[string\]\$commandLine\) \{[\s\S]*?\n\}/,
      );
    assert.ok(helper);
    const ps = (value) => "'" + value.replaceAll("'", "''") + "'";
    const oldEntry = path.join(oldDir, "src", "cli.js");
    const oldCmd =
      'node.exe "' + oldEntry + '" agent "C:\\private\\agent.json"';
    const directCmd =
      'node.exe "' + path.join(repo, "src", "cli.js") + '" agent';
    const invalidCmd =
      'node.exe "' + path.join(releases, "wrong", "src", "cli.js") + '" agent';
    const code = [
      "$ErrorActionPreference = 'Stop'",
      "$repo = " + ps(repo),
      "$releases = " + ps(releases),
      "$TargetSha = " + ps(target),
      helper[0],
      "$managed = ResolvePreviousAgentSource " + ps(oldCmd),
      "if ($managed.PreviousSha -cne " +
        ps(oldSha) +
        ") { throw 'BAD_PREVIOUS_SHA' }",
      "if ($managed.Entry -ine " + ps(oldEntry) + ") { throw 'BAD_ENTRY' }",
      "if ($managed.WorkDir -ine " + ps(oldDir) + ") { throw 'BAD_WORKDIR' }",
      "$direct = ResolvePreviousAgentSource " + ps(directCmd),
      "if ($null -ne $direct.PreviousSha) { throw 'DIRECT_INVALID' }",
      "try {",
      " $null = ResolvePreviousAgentSource " + ps(invalidCmd),
      " throw 'INVALID_ACCEPTED'",
      "} catch {",
      " if ($_.Exception.Message -ne 'EXISTING_AGENT_RELEASE_PATH_REQUIRES_MANUAL_REVIEW') { throw }",
      "}",
      "Write-Output 'MANAGED_PRIOR_RELEASE_ROLLBACK=PASS'",
    ].join("\n");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", code],
      { shell: false, timeout: 25000, windowsHide: true, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /MANAGED_PRIOR_RELEASE_ROLLBACK=PASS/);
  },
);

test("one-click native launch requires pinned known reviewed SHA and sibling script", () => {
  const source = fs.readFileSync(launcherPath, "utf8");
  assert.match(source, new RegExp(PINNED));
  assert.match(source, /%~dp0p720-native-agent-update\.ps1/);
  assert.match(source, /-NoProfile -NonInteractive/);
  assert.match(source, /CODEBRIDGE_UPDATE_EXIT/);
  assert.match(source, /-AllowTrackedDirtyCheckout -AllowUntrackedFiles/);
  assert.match(
    source,
    /Opted-in tracked edits and bounded untracked files are SHA256-fingerprinted/,
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
