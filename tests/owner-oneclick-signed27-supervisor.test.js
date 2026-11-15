import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const sourcePath = "scripts/production/owner_oneclick_signed27_supervisor.py";
const source = fs.readFileSync(sourcePath, "utf8");

test("one-click gate defaults to no mutation and requires explicit owner GO", () => {
  assert.match(source, /need\(argv in \(\[\], \["--apply", CONFIRM\]\)/);
  assert.match(source, /ownerGo/);
  assert.match(source, /helperSha256/);
  assert.match(source, /OWNER_HELPER_HASH_MISMATCH/);
  assert.match(source, /ONECLICK_PREFLIGHT=PASS_NO_MUTATIONS/);
  assert.match(source, /ALREADY_APPLIED_NO_MUTATION/);
  assert.match(source, /REQUIRED_NEXT=CODEBRIDGE_THREE_FIXED_READONLY_MCP_RECEIPTS/);
});

test("one-click gate verifies pinned owner Ed25519 signature and live gateway", () => {
  assert.match(source, /SIGNED27_ED25519_VERIFICATION_FAILED/);
  assert.match(source, /OWNER_KEY_FINGERPRINT/);
  assert.match(source, /MANIFEST_SHA256/);
  assert.match(source, /ARCHIVE_SHA256/);
  assert.match(source, /GATEWAY_PROCESS_RELEASE_MISMATCH/);
  assert.match(source, /GATEWAY_RESTARTED=NO/);
  assert.doesNotMatch(source, /shell=True|os\.system|sudo -|rm -rf/);
});

test("Python one-click failure and idempotency fixtures pass on Linux", { skip: process.platform !== "linux" }, () => {
  const run = spawnSync(
    "python3",
    ["-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_owner_oneclick_signed27_supervisor.py", "-v"],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(run.status, 0, String(run.stderr || run.error).slice(-4000));
  assert.match(run.stderr, /Ran 13 tests/);
});
