import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const launcher = fs.readFileSync(path.resolve("scripts/windows/START-KMJ-CALIBRATION-IDE.cmd"), "utf8");
const bootstrap = fs.readFileSync(path.resolve("scripts/windows/BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1"));
const digest = createHash("sha256").update(bootstrap).digest("hex");

test("downloaded bootstrap matches exact immutable launcher SHA256 pin", () => {
  const match = launcher.match(/set "KMJ_IDE_SOURCE_SHA256=([a-f0-9]{64})"/);
  assert.ok(match, "launcher must specify SHA256 of the exact companion script");
  assert.equal(match[1], digest);
  assert.match(launcher, /KMJ_IDE_SCRIPT_TRUST=BLOCKED_SHA256_MISMATCH/);
  assert.match(launcher, /KMJ_IDE_SCRIPT_TRUST=PINNED_SHA256_PASS/);
});

test("only the pinned downloaded bootstrap may have Mark-of-the-Web removed", () => {
  assert.match(launcher, /Get-FileHash -LiteralPath \$f -Algorithm SHA256/);
  assert.match(launcher, /Get-Item -LiteralPath \$f -Stream Zone\.Identifier/);
  assert.match(launcher, /Unblock-File -LiteralPath \$f -ErrorAction Stop/);
  assert.match(launcher, /KMJ_IDE_SCRIPT_TRUST=BLOCKED_CHANGED_FILE/);
  assert.match(launcher, /-ExecutionPolicy RemoteSigned/);
  assert.doesNotMatch(launcher, /ExecutionPolicy Bypass|Set-ExecutionPolicy|Unblock-File -Path.*\*/i);
});

test("launcher has no alternate command, privilege escalation or unrelated host changes", () => {
  assert.match(launcher, /DESKTOP-5FVJMET/);
  assert.match(launcher, /%~dp0BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME\.ps1/);
  assert.doesNotMatch(launcher, /\b(?:RunAs|Start-Process|schtasks|reg add|setx|Remove-Item|git reset|git clean|Set-Service)\b/i);
  assert.doesNotMatch(launcher, /projector|scanpattern|CameraStart|CalibrationImport/i);
});
