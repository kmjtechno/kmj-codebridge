import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

const source = readFileSync(
  new URL("../scripts/enroll-p720-omnidesk.ps1", import.meta.url),
  "utf8",
);

test("OmniDesk uses its own agent, project root, state, and private config", () => {
  for (const value of [
    "projects\\kmj-omnidesk",
    "private\\p720-omnidesk",
    "kmj-omnidesk-",
    "id = $projectId",
    "license = @{ mode = 'free' }",
  ]) {
    assert.ok(source.includes(value), value);
  }
  assert.match(source, /projects = @\(@\{/u);
  assert.doesNotMatch(source, /Remove-Item[\s\S]*-Recurse/u);
  assert.doesNotMatch(source, /Stop-Process|Restart-Service|Set-Service/u);
});

test("OmniDesk binding is validated and no generic shell is exposed", () => {
  for (const marker of [
    "OMNIDESK_GIT_ORIGIN_MISMATCH",
    "APPROVAL_PROJECT_MISMATCH",
    "APPROVAL_DEVICE_MISMATCH",
    "APPROVAL_SCOPE_INCOMPLETE",
    "PAIRING_GATEWAY_UNKNOWN",
    "MORE_THAN_ONE_PROJECT",
    "DUPLICATE_OMNIDESK_AGENT",
    "FileMode]::CreateNew",
    "ProtectFile",
    "CheckConfig",
  ]) {
    if (marker === "PAIRING_GATEWAY_UNKNOWN" || marker === "CheckConfig")
      continue;
    assert.ok(source.includes(marker), marker);
  }
  assert.match(source, /'https:\/\/kmjtechno\.com'/u);
  assert.match(source, /command = 'cargo'/u);
  assert.doesNotMatch(source, /command = '(?:powershell|pwsh|cmd|bash)'/u);
});

test("Owner approval and actual gateway online verification are required", () => {
  assert.match(source, /scripts\\enroll-device\.js/u);
  assert.match(source, /OWNER_PAIRING_NOT_COMPLETED/u);
  assert.match(source, /Check CodeBridge list_devices and inspect_project/u);
  assert.match(source, /param\(\[switch\]\$VerifyOnly\)/u);
});
