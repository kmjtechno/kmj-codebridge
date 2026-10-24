import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  "scripts/windows/ONE-CLICK-AGENT-AUTOCONNECT.ps1",
  "utf8",
);

const begin = source.indexOf(
  "if ($Interactive -and [IO.Path]::GetFileName($Target) -ceq $pairName)",
);
const end = source.indexOf("# Reconnect diagnostics are sanitized", begin);
const ownerPair = source.slice(begin, end);

test("owner pairing sends temporary browser instructions to the host, not captured output", () => {
  assert.ok(begin > 0 && end > begin);
  assert.ok(
    ownerPair.includes("& $systemPs @head @Arguments | ForEach-Object"),
  );
  assert.ok(ownerPair.includes("Write-Host $line"));
  assert.ok(ownerPair.includes("ENROLLMENT_STAGE="));
  assert.ok(ownerPair.includes("Open: https://kmjtechno"));
  assert.ok(ownerPair.includes("Pairing code: "));
  assert.ok(
    ownerPair.includes(
      "return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = @() }",
    ),
  );
  assert.ok(!ownerPair.includes("Write-Output $line"));
});

test("only interactive first pairing can stream temporary approval code", () => {
  assert.ok(
    ownerPair.includes("[IO.Path]::GetFileName($Target) -ceq $pairName"),
  );
  assert.ok(ownerPair.includes("[A-Za-z0-9-]{4,32}"));
  assert.ok(ownerPair.includes("$line.Length -le 2200"));
  assert.ok(
    source.includes(
      "Never enter this branch from the silent sign-in reconnect",
    ),
  );
  assert.ok(
    source.includes("$lines = @(& $systemPs @head @Arguments 2>$null)"),
  );
});

test("enrollment script reports secret-free stage markers", () => {
  const enrollment = fs.readFileSync("scripts/enroll-device.js", "utf8");
  for (const stage of [
    "ENROLLMENT_STAGE=REQUEST_CREATED",
    "ENROLLMENT_STAGE=APPROVAL_RECEIVED",
    "ENROLLMENT_STAGE=PRIVATE_GRANT_SAVED",
  ]) {
    assert.ok(enrollment.includes(stage));
  }
  assert.ok(!ownerPair.includes("Write-Host $Grant"));
});
