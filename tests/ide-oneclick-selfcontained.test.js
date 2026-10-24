import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  "scripts/windows/KMJ-CODEBRIDGE-CONNECT-NOW.cmd",
  "utf8",
);

test("self-contained download has distinct PC and runtime checks", () => {
  assert.match(source, /DESKTOP-5FVJMET/);
  assert.match(source, /BLOCKED_PC_ID_MISMATCH/);
  assert.match(source, /ACTUAL_PC=%COMPUTERNAME%/);
  assert.match(source, /REUSED_EXISTING_TRACKED_CLEAN/);
  assert.match(source, /CONNECT_RUNTIME_EXISTS_REVIEW_REQUIRED/);
  assert.match(source, /DESTINATION_EXISTS_NO_OVERWRITE/);
  assert.doesNotMatch(source, /BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME\.ps1/);
});

test("one click invokes pinned code with approval", () => {
  assert.match(source, /-ExecutionPolicy RemoteSigned/);
  assert.match(source, /ONE-CLICK-AGENT-AUTOCONNECT\.ps1/);
  assert.match(source, /-Device HomeOffice/);
  assert.match(source, /9dc0ae25648c33a62631fdd35068e6b60820637d/);
  assert.match(source, /npm\.Source ci --ignore-scripts --no-audit --no-fund/);
  assert.match(
    source,
    /CODEBRIDGE_GATEWAY_READY' 'NOT_ATTESTED_VERIFY_IN_CHAT/,
  );
  assert.doesNotMatch(
    source,
    /ExecutionPolicy Bypass|Set-ExecutionPolicy|RunAs|git reset|git clean|schtasks/i,
  );
});

test("one click has no embedded credentials or shell override", () => {
  assert.doesNotMatch(
    source,
    /deviceToken|bearerToken|enrollment\.json|Set-Content|ConvertTo-Json|reg add/i,
  );
  assert.doesNotMatch(source, /-RunOpticalBench|-ScanProjector/i);
});

test("older checkout lacking auto-connect skips without native Git pathspec failure", () => {
  assert.doesNotMatch(source, /ls-files --error-unmatch/);
  assert.ok(source.includes("ls-tree -r --name-only HEAD -- @req"));
  assert.ok(source.includes("scripts/windows/CONNECT-CALIBRATION-PRO.ps1"));
  assert.ok(source.includes("scripts/windows/PAIR-HOMEOFFICE-CALIBRATION.ps1"));
  assert.ok(source.includes("$tracked.Count -ne 3"));
  assert.ok(source.includes("}catch{return $false}"));
  assert.match(source, /OLD_RUNTIME_PRESERVED/);
  assert.match(source, /CodeBridge-HomeOffice-Connect-v1/);
  assert.match(source, /BLOCKED_LOCAL_VALIDATION_OR_NETWORK/);
});

test("Windows command stays within the CMD character limit", () => {
  const commandLine = source.split("\n").find((line) => line.includes("-Command "));
  assert.ok(commandLine);
  assert.ok(commandLine.length < 8191);
});
