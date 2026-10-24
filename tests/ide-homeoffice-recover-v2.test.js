import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  "scripts/windows/KMJ-CODEBRIDGE-HOMEOFFICE-RECOVER.cmd",
  "utf8",
);

test("Home Office v2 one-click must verify immutable correct source", () => {
  assert.ok(source.includes("4b6eee169b057451d3e512cd0197be08879bf8f6"));
  assert.ok(source.includes("CodeBridge-HomeOffice-Connect-v2"));
  assert.ok(source.includes("$actual.Trim() -cne $env:KMJ_CB_SHA"));
  assert.ok(source.includes("HEAD_MISMATCH"));
  assert.ok(source.includes("DESTINATION_EXISTS_NO_OVERWRITE"));
  assert.ok(source.includes("OLD_RUNTIME_PRESERVED"));
  assert.ok(!source.includes("Set-ExecutionPolicy"));
  assert.ok(!source.includes("ExecutionPolicy Bypass"));
  assert.ok(!source.includes("git reset"));
  assert.ok(!source.includes("git clean"));
});

test("only owner-approved re-pair follows explicit stale registration revocation", () => {
  assert.ok(
    source.includes("BLOCKED_EXISTING_PRIVATE_ENROLLMENT_REVIEW_REQUIRED"),
  );
  assert.ok(source.includes("homeoffice-calibration-pro\\agent.json"));
  assert.ok(source.includes("homeoffice-calibration-pro\\enrollment.json"));
  assert.ok(source.includes("choice /C YN /N /M"));
  assert.ok(
    source.includes("if errorlevel 2 goto :owner_confirmation_missing"),
  );
  assert.ok(
    source.includes(
      "OWNER_REVOKE_CONFIRMATION=YES_AT_CONSOLE_NOT_SERVER_VERIFIED",
    ),
  );
  assert.ok(
    source.includes(
      "https://kmjtechno.com/services/kmj-codebridge#codebridge-device-control",
    ),
  );
  assert.ok(source.includes("BLOCKED_PC_ID_MISMATCH"));
  assert.ok(source.includes("ACCOUNT_SIDE_READY") === false);
  assert.ok(
    source.includes("CODEBRIDGE_GATEWAY_READY' 'NOT_ATTESTED_VERIFY_IN_CHAT"),
  );
});

test("safe cmd constraints and owner privacy hold", () => {
  const commandLine = source
    .split("\n")
    .find((line) => line.includes('-Command "'));
  assert.ok(commandLine);
  assert.ok(commandLine.length < 8191);
  assert.ok(!source.includes("agent.token"));
  assert.ok(!source.includes("Write-Output $token"));
  assert.ok(source.includes("No global policy bypass"));
  assert.ok(source.includes("-ExecutionPolicy RemoteSigned"));
});
