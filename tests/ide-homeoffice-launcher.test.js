import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const file = path.resolve("scripts/windows/ONE-CLICK-CALIBRATION-IDE.cmd");
const source = fs.readFileSync(file, "utf8");

test("IDE launcher checks exact Home Office PC and invokes only approved scripts", () => {
  assert.match(source, /DESKTOP-5FVJMET/);
  assert.match(source, /%~dp0ONE-CLICK-AGENT-AUTOCONNECT\.ps1/);
  assert.match(source, /%~dp0CODEBRIDGE-DEVICE-DOCTOR\.ps1/);
  assert.match(source, /-Device HomeOffice/);
  assert.match(source, /-ExecutionPolicy RemoteSigned/);
  assert.match(source, /NoProfile/);
  assert.match(source, /CONNECTION_LAUNCH_EXIT=%RC%/);
  assert.match(source, /Do not share agent\.json/);
});

test("IDE launcher cannot self-approve, elevate, deploy or rewrite project checkout", () => {
  assert.doesNotMatch(
    source,
    /ExecutionPolicy Bypass|RunAs|schtasks|\b(?:curl|wget|npm|git|powershell -enc|setx|reg add|net user)\b/i,
  );
  assert.doesNotMatch(
    source,
    /\b(?:reset|clean|force-push|Remove-Item|Set-Date|Set-Service|Install-Service|Restart-Service)\b/i,
  );
  assert.doesNotMatch(
    source,
    /-RunOpticalBench|ScanProjector|PROJECTOR_PATTERN/i,
  );
});

const installerCmd = fs.readFileSync(
  path.resolve("scripts/windows/START-KMJ-CALIBRATION-IDE.cmd"),
  "utf8",
);
const bootstrapPs1 = fs.readFileSync(
  path.resolve("scripts/windows/BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1"),
);

test("downloaded P520 installer verifies exact SHA-256 before per-file unblock", async () => {
  const { createHash } = await import("node:crypto");
  const pinned = createHash("sha256")
    .update(bootstrapPs1)
    .digest("hex")
    .toUpperCase();
  assert.match(installerCmd, /DESKTOP-5FVJMET/);
  assert.ok(
    installerCmd.includes("'" + pinned + "'"),
    "installer content hash must match audited source",
  );
  assert.match(installerCmd, /Get-FileHash -LiteralPath \$p -Algorithm SHA256/);
  assert.match(installerCmd, /Unblock-File -LiteralPath \$p -ErrorAction Stop/);
  assert.ok(
    installerCmd.indexOf("Get-FileHash") < installerCmd.indexOf("Unblock-File"),
  );
  assert.match(installerCmd, /if errorlevel 1 goto :integrity_blocked/);
  assert.match(installerCmd, /SCRIPT_SHA256_MISMATCH/);
  assert.match(installerCmd, /SCRIPT_REPARSE_DENIED/);
  assert.match(
    installerCmd,
    /-ExecutionPolicy RemoteSigned -File "%INSTALLER%"/,
  );
});

test("installer does not disable script security or auto-pair another device", () => {
  assert.doesNotMatch(
    installerCmd,
    /-ExecutionPolicy (?:Bypass|Unrestricted)|Set-ExecutionPolicy|Unblock-File -Path ["']?\\*|Start-Process.*RunAs|schtasks|DESKTOP-K3AHHEM/i,
  );
  assert.doesNotMatch(
    installerCmd,
    /-Device P720|Remove-Item|git reset|git clean/i,
  );
  assert.match(installerCmd, /EXECUTION_POLICY_CHANGED=NO/);
});

test("installer labels are after normal execution and wrong PC fails closed", () => {
  assert.match(
    installerCmd,
    /if \/I not "%OS%"=="Windows_NT" goto :unsupported_os\necho IDE_CURRENT_WINDOWS_HOST=%COMPUTERNAME%\nif \/I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" goto :wrong_host/,
  );
  assert.ok(
    installerCmd.lastIndexOf("\n:integrity_blocked\n") >
      installerCmd.indexOf("exit /b %RC%"),
  );
  for (const label of [
    "unsupported_os",
    "wrong_host",
    "missing_script",
    "missing_powershell",
  ]) {
    assert.equal(
      (installerCmd.match(new RegExp("^:" + label + "$", "gm")) || []).length,
      1,
    );
  }
  assert.equal((installerCmd.match(/^:integrity_blocked$/gm) || []).length, 1);
});

test("P520 installer names missing ZIP files and wrong Windows host separately", () => {
  assert.match(installerCmd, /IDE_SETUP=BLOCKED_BOOTSTRAP_SCRIPT_MISSING/);
  assert.match(installerCmd, /IDE_SETUP=BLOCKED_WRONG_HOST/);
  assert.match(installerCmd, /IDE_SETUP=BLOCKED_WINDOWS_POWERSHELL_MISSING/);
  assert.match(installerCmd, /IDE_SETUP=BLOCKED_NOT_WINDOWS/);
  assert.match(installerCmd, /SCRIPT_ALLSIGNED_REQUIRES_SIGNATURE/);
  assert.match(installerCmd, /SCRIPT_CHANGED_DURING_UNBLOCK/);
  assert.doesNotMatch(installerCmd, /BLOCKED_WRONG_HOST_OR_SCRIPT_MISSING/);
});

const installerBootstrap = fs.readFileSync(
  path.resolve("scripts/windows/BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1"),
  "utf8",
);

test("pre-existing untrusted P520 runtime is preserved; new exact-SHA install uses separate sibling", () => {
  assert.match(installerBootstrap, /\$isolatedDest = Join-Path 'E:\\\\KMJ'/);
  assert.match(installerBootstrap, /\$sha\.Substring\(0,12\)/);
  assert.match(installerBootstrap, /KMJ_IDE_PREVIOUS_RUNTIME.*UNVERIFIED_PRESERVED_UNCHANGED/);
  assert.match(installerBootstrap, /OrdinaryDirectory \$dest/);
  assert.match(installerBootstrap, /ISOLATED_DESTINATION_OCCUPIED_NO_OVERWRITE/);
  assert.match(installerBootstrap, /\$installDest = \$isolatedDest/);
  assert.match(installerBootstrap, /Move-Item -LiteralPath \$stage -Destination \$installDest/);
  assert.match(installerBootstrap, /TrustedRuntime \$installDest \$git/);
  assert.doesNotMatch(installerBootstrap, /EXISTING_DESTINATION_NOT_OVERWRITTEN/);
  assert.doesNotMatch(installerBootstrap, /Remove-Item|git reset|git clean|\b-Force\b/);
});
