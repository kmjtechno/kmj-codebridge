import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = fs.readFileSync(
  new URL(
    "../scripts/windows/P520-OPENHANDS-CANVAS-PILOT.ps1",
    import.meta.url,
  ),
  "utf8",
);
const executableSource = source
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

test("deployment launcher defaults to read-only and requires explicit start", () => {
  assert.match(source, /\[switch\]\$Start/);
  assert.match(source, /if \(-not \$Start\) \{/);
  assert.match(source, /OPENHANDS_PRECHECK=PASS_START_NOT_REQUESTED/);
  assert.match(source, /OPENHANDS_WRONG_HOST_P520_ONLY/);
});

test("official v1.40.0 image, local desktop engine and loopback only", () => {
  assert.match(source, /ghcr\.io\/openhands\/agent-canvas:1\.40\.0/);
  assert.match(source, /desktop-linux/);
  assert.match(source, /127\.0\.0\.1:8000:8000/);
  assert.doesNotMatch(executableSource, /--privileged|--network[ =]host|0\.0\.0\.0:8000/);
});

test("workspace mount is dedicated and host docker socket not passed", () => {
  assert.match(source, /OpenHandsPilot/);
  assert.match(source, /target=\/projects/);
  assert.match(source, /OPENHANDS_NONEMPTY_WORKSPACE_REQUIRES_EXPLICIT_REUSE/);
  assert.match(source, /OPENHANDS_NESTED_REPARSE_DENIED/);
  assert.doesNotMatch(executableSource, /docker\.sock|docker_engine|--volume\s+C:/i);
});

test("no automatic model or cloud credential enabling", () => {
  assert.doesNotMatch(
    source,
    /OPENAI_API_KEY|ANTHROPIC_API_KEY|LLM_API_KEY|--restart\s+always/,
  );
  assert.match(source, /OPENHANDS_AUTH_AND_AGENT_EXECUTION=NOT_VERIFIED/);
});

test("PowerShell 5.1 syntax parse on Windows without executing launcher", () => {
  if (process.platform !== "win32") return;
  const path = fileURLToPath(
    new URL(
      "../scripts/windows/P520-OPENHANDS-CANVAS-PILOT.ps1",
      import.meta.url,
    ),
  );
  const literalPath = path.replace(/'/g, "''");
  const command =
    "$tokens=$null; $errors=$null; " +
    "[void][System.Management.Automation.Language.Parser]::ParseFile('" +
    literalPath +
    "',[ref]$tokens,[ref]$errors); if ($errors.Count) { " +
    "$errors | Out-String | Write-Error; exit 1 }";
  const child = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
