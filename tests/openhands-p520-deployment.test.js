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
  assert.doesNotMatch(
    executableSource,
    /--privileged|--network[ =]host|0\.0\.0\.0:8000/,
  );
});

test("workspace mount is dedicated and host docker socket not passed", () => {
  assert.match(source, /OpenHandsPilot/);
  assert.match(source, /target=\/projects/);
  assert.match(source, /OPENHANDS_NONEMPTY_WORKSPACE_REQUIRES_EXPLICIT_REUSE/);
  assert.match(source, /OPENHANDS_NESTED_REPARSE_DENIED/);
  assert.doesNotMatch(
    executableSource,
    /docker\.sock|--volume\s+C:|--mount\s+[^\n]*docker_engine/i,
  );
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

test("PowerShell 5.1 mode validation handles two switches with StrictMode", () => {
  if (process.platform !== "win32") return;
  const path = fileURLToPath(
    new URL(
      "../scripts/windows/P520-OPENHANDS-CANVAS-PILOT.ps1",
      import.meta.url,
    ),
  );
  const child = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path,
      "-Start",
      "-Status",
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  const output = child.stdout + child.stderr;
  assert.notEqual(child.status, 0);
  assert.match(output, /OPENHANDS_ONE_MODE_ONLY/);
  assert.doesNotMatch(output, /PropertyNotFoundStrict|property 'Count'/i);
});

test("PowerShell 5.1 singleton -Start reaches host guard, never Docker in CI", () => {
  if (
    process.platform !== "win32" ||
    process.env.COMPUTERNAME === "DESKTOP-5FVJMET"
  )
    return;
  const path = fileURLToPath(
    new URL(
      "../scripts/windows/P520-OPENHANDS-CANVAS-PILOT.ps1",
      import.meta.url,
    ),
  );
  const child = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path,
      "-Start",
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  const output = child.stdout + child.stderr;
  assert.notEqual(child.status, 0);
  assert.match(output, /OPENHANDS_WRONG_HOST_P520_ONLY/);
  assert.doesNotMatch(output, /PropertyNotFoundStrict|property 'Count'/i);
});

test("finds per-user and machine Docker Desktop without weakening context policy", () => {
  assert.match(source, /Programs\\DockerDesktop\\resources\\bin\\docker\.exe/);
  assert.match(source, /Docker\\Docker\\resources\\bin\\docker\.exe/);
  assert.match(source, /OPENHANDS_DOCKER_SETUP=winget install/);
  assert.match(source, /OPENHANDS_DOCKER_HOST_OVERRIDE_DENIED/);
  assert.match(source, /OPENHANDS_DOCKER_CONTEXT_OVERRIDE_DENIED/);
  assert.match(source, /OPENHANDS_REMOTE_DOCKER_CONTEXT_DENIED/);
  assert.match(source, /npipe:\/\/\/\/\.\/pipe\/dockerDesktopLinuxEngine/);
  assert.doesNotMatch(executableSource, /--context\s+https?:|--host\s+https?:/);
});

test("PowerShell 5.1 Docker endpoint inspection avoids nested quoted Go templates", () => {
  assert.match(
    source,
    /context inspect desktop-linux --format '\{\{json \.Endpoints\}\}'/,
  );
  assert.doesNotMatch(source, /\{\{\(index \.Endpoints/);
  assert.match(source, /ConvertFrom-Json -InputObject/);
  assert.match(source, /\$endpoints\.PSObject\.Properties\['docker'\]/);
  assert.match(source, /\$dockerEntry\.Value\.PSObject\.Properties\['Host'\]/);
  assert.match(source, /OPENHANDS_REMOTE_DOCKER_CONTEXT_DENIED/);
});
