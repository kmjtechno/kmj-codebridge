import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = new URL(
  "../scripts/windows/P520-OPENHANDS-ENABLE-WSL.ps1",
  import.meta.url,
);
const source = fs.readFileSync(path, "utf8");
const executable = source
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

test("WSL repair is restricted to P520 and explicit apply", () => {
  assert.match(source, /\[switch\]\$Apply/);
  assert.match(source, /KMJ_WSL_WRONG_HOST/);
  assert.match(source, /if \(-not \$Apply\) \{/);
  assert.match(source, /KMJ_WSL_REPAIR=READY_FOR_ADMIN_APPLY/);
  assert.match(source, /KMJ_WSL_ADMIN_REQUIRED/);
});

test("WSL repair enables only the missing feature without reboot", () => {
  assert.match(source, /VirtualMachinePlatform/);
  assert.match(source, /KMJ_WSL_VIRTUAL_MACHINE_PLATFORM_NOT_ENABLED/);
  assert.match(source, /\/enable-feature \/featurename:Microsoft-Windows-Subsystem-Linux \/all \/norestart/);
  assert.match(source, /DISM_EXIT_CODE=/);
  assert.match(source, /KMJ_WSL_REBOOT=OWNER_CONTROLLED_REQUIRED_BEFORE_VERIFICATION/);
});

test("WSL repair cannot unregister, reset Docker, reboot or change BCD", () => {
  assert.doesNotMatch(
    executable,
    /\b(?:Restart-Computer|Stop-Computer|shutdown(?:\.exe)?\s+\/r|wsl(?:\.exe)?\s+--(?:unregister|shutdown|terminate|install)|docker(?:\.exe)?\s+(?:system|volume|rm|rmi|stop)|bcdedit(?:\.exe)?\s+\/set)\b/i,
  );
  assert.doesNotMatch(executable, /\b(?:Start-Process|Remove-Item|Set-ItemProperty|Enable-WindowsOptionalFeature)\b/i);
});

test("WSL repair parses under PowerShell 5.1 on Windows CI", () => {
  if (process.platform !== "win32") return;
  const quotedPath = fileURLToPath(path).replace(/'/g, "''");
  const check =
    "$tokens=$null; $errors=$null; " +
    "[void][System.Management.Automation.Language.Parser]::ParseFile('" +
    quotedPath +
    "',[ref]$tokens,[ref]$errors); " +
    "if ($errors.Count) {$errors | Out-String | Write-Error; exit 1}";
  const child = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", check],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("WSL repair refuses the wrong host before any privileged change", () => {
  if (
    process.platform !== "win32" ||
    process.env.COMPUTERNAME === "DESKTOP-5FVJMET"
  )
    return;
  const child = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(path),
      "-Apply",
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.notEqual(child.status, 0);
  assert.match(child.stdout + child.stderr, /KMJ_WSL_WRONG_HOST/);
});
