import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const updater = path.resolve("scripts/p720-native-agent-update.ps1");
const source = fs.readFileSync(updater, "utf8");

test("managed standalone release trust remains restricted to an immutable local Git object", () => {
  assert.match(source, /function ResolvePreviousAgentSource/);
  assert.match(source, /EXISTING_AGENT_RELEASE_GIT_UNTRUSTED/);
  assert.match(source, /EXISTING_AGENT_RELEASE_ORIGIN_UNTRUSTED/);
  assert.match(source, /EXISTING_AGENT_RELEASE_TRACKED_DIRTY/);
  assert.match(source, /EXISTING_AGENT_RELEASE_CLI_UNTRUSTED/);
  assert.match(source, /rev-parse --absolute-git-dir/);
  assert.match(source, /remote get-url origin/);
  assert.match(source, /status --porcelain=v1 --untracked-files=no/);
  assert.match(source, /rev-parse 'HEAD:src\/cli\.js'/);
  assert.match(source, /hash-object -- 'src\/cli\.js'/);
  assert.match(source, /PREVIOUS_RELEASE_NOT_ANCESTOR/);
  assert.match(
    source,
    /StartScoped \$oldEntry \$oldWorkDir 'rollback-previous'/,
  );
  assert.doesNotMatch(source, /git\s+(?:reset|clean|push|pull)\s+--force/i);
});

test(
  "Windows permits only canonical clean standalone prior release and rejects compromised rollback",
  { skip: process.platform !== "win32" },
  (t) => {
    const base = fs.mkdtempSync(
      path.join(os.tmpdir(), "p720-legacy-standalone-"),
    );
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const repo = path.join(base, "main");
    const releases = path.join(base, "codebridge-releases");
    fs.mkdirSync(repo);
    fs.mkdirSync(releases);
    const git = (...args) => {
      const output = spawnSync("git", args, {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 25000,
      });
      assert.equal(output.status, 0, output.stderr);
      return output.stdout.trim();
    };
    git("-C", repo, "init", "-q");
    git("-C", repo, "config", "user.name", "CI");
    git("-C", repo, "config", "user.email", "ci@example.invalid");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "cli.js"), "export {};\n");
    git("-C", repo, "add", "src/cli.js");
    git("-C", repo, "commit", "-qm", "legacy source");
    const priorSha = git("-C", repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "later.txt"), "new release\n");
    git("-C", repo, "add", "later.txt");
    git("-C", repo, "commit", "-qm", "new target");
    const targetSha = git("-C", repo, "rev-parse", "HEAD");
    const standalone = path.join(releases, priorSha);
    git("clone", "-q", repo, standalone);
    git("-C", standalone, "checkout", "-q", "--detach", priorSha);
    git(
      "-C",
      standalone,
      "remote",
      "set-url",
      "origin",
      "https://github.com/kmjtechno/kmj-codebridge.git",
    );

    const resolver = source.match(
      /function ResolvePreviousAgentSource\(\[string\]\$commandLine\) \{[\s\S]*?\n\}/,
    );
    assert.ok(resolver);
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    const priorEntry = path.join(standalone, "src", "cli.js");
    const commandLine =
      "node.exe " + quote(priorEntry) + " agent C:\\private\\agent.json";
    const definitions = [
      "$ErrorActionPreference = 'Stop'",
      "$repo = " + quote(repo),
      "$releases = " + quote(releases),
      "$TargetSha = " + quote(targetSha),
      "$allowedOrigins = @('https://github.com/kmjtechno/kmj-codebridge.git')",
      resolver[0],
      "$cmdLine = " + quote(commandLine),
    ];
    const runPowerShell = (lines) => {
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", lines.join("\n")],
        {
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          timeout: 25000,
        },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    };
    const trusted = runPowerShell([
      ...definitions,
      "$previous = ResolvePreviousAgentSource $cmdLine",
      "if ($previous.PreviousSha -cne " +
        quote(priorSha) +
        ") { throw 'UNEXPECTED_OLD_SHA' }",
      "if ($previous.Entry -ine " +
        quote(priorEntry) +
        ") { throw 'UNEXPECTED_OLD_ENTRY' }",
      "Write-Output 'STANDALONE_PRIOR_RELEASE=PASS'",
    ]);
    assert.match(trusted, /STANDALONE_PRIOR_RELEASE=PASS/);

    fs.appendFileSync(priorEntry, "// bad modification\n");
    const dirty = runPowerShell([
      ...definitions,
      "$blocked = $false",
      "try { ResolvePreviousAgentSource $cmdLine | Out-Null } catch {",
      " $blocked = $_.Exception.Message -eq 'EXISTING_AGENT_RELEASE_TRACKED_DIRTY'",
      "}",
      "if (!$blocked) { throw 'DIRTY_RELEASE_ACCEPTED' }",
      "Write-Output 'DIRTY_RELEASE_DENIED=PASS'",
    ]);
    assert.match(dirty, /DIRTY_RELEASE_DENIED=PASS/);

    fs.writeFileSync(priorEntry, "export {};\n");
    git(
      "-C",
      standalone,
      "remote",
      "set-url",
      "origin",
      "https://evil.example/x",
    );
    const wrongOrigin = runPowerShell([
      ...definitions,
      "$blocked = $false",
      "try { ResolvePreviousAgentSource $cmdLine | Out-Null } catch {",
      " $blocked = $_.Exception.Message -eq 'EXISTING_AGENT_RELEASE_ORIGIN_UNTRUSTED'",
      "}",
      "if (!$blocked) { throw 'WRONG_ORIGIN_ACCEPTED' }",
      "Write-Output 'UNTRUSTED_ORIGIN_DENIED=PASS'",
    ]);
    assert.match(wrongOrigin, /UNTRUSTED_ORIGIN_DENIED=PASS/);
  },
);
