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
