import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("P520 OmniDesk launcher is scope-fixed and never installs or bypasses authorization", () => {
  const text = fs.readFileSync(
    "scripts/windows/CONNECT-P520-OMNIDESK.cmd",
    "utf8",
  );
  assert.match(text, /DESKTOP-5FVJMET/);
  assert.match(text, /E:\\KMJ\\KMJ OmniDesk/);
  assert.match(text, /ONE-CLICK-ANY-DEVICE\.ps1/);
  assert.match(text, /-ProjectRoot "%PROJECT%"/);
  assert.match(text, /-ExecutionPolicy RemoteSigned/);
  assert.match(text, /VERIFY_ACCOUNT_PROJECT_READY_SEPARATELY/);
  assert.doesNotMatch(
    text,
    /P720|calibration-pro|agent\.json|enrollment\.json|Bearer |GITHUB_TOKEN|curl\b|Invoke-WebRequest|ExecutionPolicy Bypass|git clone|git reset|git clean|schtasks/i,
  );
});
