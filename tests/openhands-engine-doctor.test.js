import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const doctorPath = new URL(
  "../scripts/windows/P520-OPENHANDS-ENGINE-DOCTOR.ps1",
  import.meta.url,
);
const source = fs.readFileSync(doctorPath, "utf8");
const executable = source
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

test("read-only Docker engine doctor gathers bounded prerequisite evidence", () => {
  assert.match(source, /KMJ_OPENHANDS_ENGINE_DOCTOR=READ_ONLY_V1/);
  assert.match(source, /OPENHANDS_ENGINE_DOCTOR_P520_ONLY/);
  assert.match(source, /Win32_Processor/);
  assert.match(source, /Win32_OptionalFeature/);
  assert.match(source, /HYPERVISOR_LAUNCH=/);
  assert.match(source, /WSL_/);
  assert.match(source, /DOCTOR_RESULT=DIAGNOSTIC_ONLY/);
});

test("doctor must not alter Windows features, WSL or Docker resources", () => {
  assert.doesNotMatch(
    executable,
    /\bwsl(?:\.exe)?\s+--(?:shutdown|unregister|update|install|set-|terminate)/i,
  );
  assert.doesNotMatch(
    executable,
    /\b(?:Enable-WindowsOptionalFeature|Disable-WindowsOptionalFeature|Install-WindowsFeature|Set-Service|Start-Service|Restart-Service)\b/i,
  );
  assert.doesNotMatch(
    executable,
    /\b(?:docker\.exe|\$docker\.Source)\s+(?:run|rm|rmi|system prune|volume|pull|start|stop|restart)/i,
  );
  assert.doesNotMatch(executable, /bcdedit(?:\.exe)?\s+\/set/i);
});

test("PowerShell 5.1 doctor parses without execution on Windows CI", () => {
  if (process.platform !== "win32") return;
  const literalPath = fileURLToPath(doctorPath).replace(/'/g, "''");
  const command =
    "$tokens=$null; $errors=$null; " +
    "[void][System.Management.Automation.Language.Parser]::ParseFile('" +
    literalPath +
    "',[ref]$tokens,[ref]$errors); if ($errors.Count) {" +
    "$errors | Out-String | Write-Error; exit 1}";
  const child = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
