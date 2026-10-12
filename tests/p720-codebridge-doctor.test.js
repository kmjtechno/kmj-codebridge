import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const doctor = fs.readFileSync("scripts/P720-CODEBRIDGE-DOCTOR.ps1", "utf8");
const launcher = fs.readFileSync("scripts/START-P720-CODEBRIDGE-DOCTOR.cmd", "utf8");

test("P720 CodeBridge doctor reads only trusted repo metadata and icon hashes", () => {
  for (const term of ["Get-FileHash", "Get-Service", "git.exe", "trustedOrigins", "liveChatGPTIcon", "NOT_VERIFIED_EXTERNALLY", "READ_ONLY"])
    assert.ok(doctor.includes(term), term);
  for (const forbidden of [/Get-Content\s+.*agent\.json/i, /Get-Content\s+.*enrollment/i, /-recurse\s+-force/i, /Restart-Service/i, /Start-Service/i, /Set-Content/i, /Invoke-WebRequest/i, /Invoke-RestMethod/i, /Remove-Item/i, /git\s+reset/i])
    assert.doesNotMatch(doctor, forbidden);
});
test("one-click launcher uses only bundled doctor and has no cloud enrollment", () => {
  assert.match(launcher, /%~dp0P720-CODEBRIDGE-DOCTOR\.ps1/);
  assert.match(launcher, /-NoProfile -NonInteractive/);
  assert.doesNotMatch(launcher, /curl\b|Invoke-WebRequest|git\s+clone|token|secret|password/i);
});
