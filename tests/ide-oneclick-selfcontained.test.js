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
  assert.match(source, /EXISTING_RUNTIME_REVIEW_REQUIRED/);
  assert.match(source, /DESTINATION_EXISTS_NO_OVERWRITE/);
  assert.doesNotMatch(source, /BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME\.ps1/);
});

test("one click uses restricted, owner-approved reconnect and exact pinned fresh clone", () => {
  assert.match(source, /-ExecutionPolicy RemoteSigned/);
  assert.match(source, /ONE-CLICK-AGENT-AUTOCONNECT\.ps1/);
  assert.match(source, /-Device HomeOffice/);
  assert.match(source, /9dc0ae25648c33a62631fdd35068e6b60820637d/);
  assert.match(source, /npm\.Source ci --ignore-scripts --no-audit --no-fund/);
  assert.match(source, /CODEBRIDGE_GATEWAY_READY' 'NOT_ATTESTED_VERIFY_IN_CHAT/);
  assert.doesNotMatch(
    source,
    /ExecutionPolicy Bypass|Set-ExecutionPolicy|RunAs|git reset|git clean|schtasks/i,
  );
});

test("one click does not embed any enrollment credentials or arbitrary command parameter", () => {
  assert.doesNotMatch(
    source,
    /deviceToken|bearerToken|enrollment\.json|Set-Content|ConvertTo-Json|reg add/i,
  );
  assert.doesNotMatch(source, /-RunOpticalBench|-ScanProjector/i);
});
