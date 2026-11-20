import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assessEliteIdentity,
  assessDeployTimer,
} from "../scripts/production/elite-onehost-release.mjs";

test("elite only, dedicated nonroot signer and Node24 are mandatory", () => {
  assert.equal(assessEliteIdentity("KMJ-elite", 995, "kmjsigner", 24), "PASS");
  assert.equal(assessEliteIdentity("kmj-elite.local", 995, "kmjsigner", "24"), "PASS");
  for (const [host, uid, user, node] of [
    ["p520", 995, "kmjsigner", 24],
    ["KMJ-elite", 0, "root", 24],
    ["KMJ-elite", 999, "kmjcode", 24],
    ["KMJ-elite", 999, "kmjsigner", 22],
    ["KMJ-elite", null, "kmjsigner", 24],
  ]) {
    assert.notEqual(assessEliteIdentity(host, uid, user, node), "PASS");
  }
});

test("deployment requires exact enabled and active signed release timer", () => {
  const pass = {
    LoadState: "loaded",
    ActiveState: "active",
    UnitFileState: "enabled",
  };
  assert.equal(assessDeployTimer(pass), "PASS");
  for (const invalid of [
    null,
    {},
    { ...pass, LoadState: "not-found" },
    { ...pass, ActiveState: "inactive" },
    { ...pass, UnitFileState: "disabled" },
    { ...pass, UnitFileState: "masked" },
  ]) {
    assert.notEqual(assessDeployTimer(invalid), "PASS");
  }
});

test("single-host operator never uses generic shell or deploys unsigned source", () => {
  const source = fs.readFileSync(
    path.resolve("scripts/production/elite-onehost-release.mjs"),
    "utf8",
  );
  assert.match(source, /SIGNER_PIN = "[a-f0-9]{64}"/);
  assert.match(source, /GATE_PIN = "[a-f0-9]{64}"/);
  assert.match(source, /guardedFile\(SIGNER, SIGNER_PIN\)/);
  assert.match(source, /guardedFile\(GATE, GATE_PIN\)/);
  assert.match(source, /UNINSTALLED_OPERATOR_REJECTED/);
  assert.match(source, /DEDICATED_NONROOT_SIGNER_REQUIRED/);
  assert.match(source, /OWNER_POLICY_NOT_APPROVED/);
  assert.match(source, /AUTO_SIGNED_RELEASE=PR_AUTO_MERGE_QUEUED/);
  assert.match(source, /ELITE_DEPLOY=SIGNED_TIMER_MANAGED_NOT_ATTESTED/);
  assert.doesNotMatch(source, /(?:bash\s+-c|sh\s+-c|shell:\s*true|StrictHostKeyChecking=no)/);
  assert.doesNotMatch(source, /(?:systemctl[^\n]*start|systemctl[^\n]*restart|--admin)/);
});

test("root-owned immutable signer supports unprivileged Git hook sandbox", () => {
  const source = fs.readFileSync(
    path.resolve("scripts/production/owner-auto-sign-stable.mjs"),
    "utf8",
  );
  assert.match(source, /hooksDir = makeIsolatedHooksDir\(STATE\)/);
  assert.doesNotMatch(source, /hooksDir = makeIsolatedHooksDir\(SCRIPT_DIR\)/);
  assert.match(source, /ROOT_SIGNER_FORBIDDEN/);
  assert.match(source, /stat\.uid === process\.getuid\(\) && !\(stat\.mode & 0o077\)/);
  assert.match(source, /protectedMain\(api\("branches\/main\/protection"\)\)/);
});

test("inspected one-host source contains no embedded credentials or private keys", () => {
  const source = fs.readFileSync(
    path.resolve("scripts/production/elite-onehost-release.mjs"), "utf8",
  );
  assert.doesNotMatch(source, /BEGIN (?:OPENSSH|PRIVATE) KEY/);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{24}/);
  assert.match(source, /PRIVATE_KEY_EXPORTED=NO/);
  assert.match(source, /PRIVATE_KEY_READ=NO/);
});
