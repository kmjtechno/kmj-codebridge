import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(
  new URL(
    "../scripts/windows/ENABLE-CALIBRATION-STUDIO-QA.ps1",
    import.meta.url,
  ),
);
const source = readFileSync(sourcePath, "utf8");

test("Studio private QA opt-in is explicit, scope-only and fail closed", () => {
  for (const marker of [
    "[switch]$Apply",
    "[switch]$SelfTest",
    "QA_PRIVATE_DEVICE_SCOPE_MISMATCH",
    "QA_STUDIO_ORIGIN_NOT_APPROVED",
    "QA_UNEXPECTED_PROJECT_SCOPE",
    "QA_CODEBRIDGE_PRESET_NOT_IN_CURRENT_SOURCE",
    "QA_CODEBRIDGE_RUNTIME_DIRTY",
    "QA_OPTIN_SCRIPT_NOT_GIT_TRACKED",
    "QA_PRIVATE_ACL_INHERITANCE_NOT_BLOCKED",
    "QA_STAGED_CODEBRIDGE_SCHEMA_REJECTED",
    "agentSchema.parse",
    "[IO.File]::Replace(",
    "KJ_CODEBRIDGE_QA_OPTIN=READY_FOR_OWNER_APPLY",
    "AGENT_PROCESS_RESTARTED=NO",
    "PRIVATE_TOKENS_PRINTED=NO",
    "KJ_CODEBRIDGE_QA_OPTIN_SELFTEST=PASS",
  ]) {
    assert.ok(
      source.includes(marker),
      "Missing fail-closed control: " + marker,
    );
  }
  assert.ok(
    source.indexOf("if(!$Apply)") < source.indexOf("[IO.File]::Replace("),
  );
  assert.ok(source.includes("qa-stage-"));
  assert.ok(source.includes("qa-backup-"));
  assert.ok(!source.includes("Remove-Item -LiteralPath $config"));
  assert.ok(!source.includes("Stop-Process"));
  assert.ok(!source.includes("Invoke-Expression"));
});

test("Windows selftest uses only disposable in-memory project scope", (t) => {
  if (process.platform !== "win32") {
    t.skip("Native PowerShell 5.1 scope-only fixture is Windows-specific");
    return;
  }
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot);
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const run = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "RemoteSigned",
      "-File",
      sourcePath,
      "-SelfTest",
    ],
    { encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  assert.equal(run.status, 0, "Owner-only Windows selftest must pass");
  assert.match(run.stdout, /KJ_CODEBRIDGE_QA_OPTIN_SELFTEST=PASS/);
  assert.match(run.stdout, /OWNER_FILES=UNTOUCHED/);
  assert.doesNotMatch(run.stdout, /BLOCKED:|token.*[A-Za-z0-9]{32}/i);
});
