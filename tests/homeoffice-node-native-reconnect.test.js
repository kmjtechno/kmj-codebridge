import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  approvedScope,
  lockPid,
  privatePath,
} from "../scripts/windows/connect-homeoffice-calibration.mjs";

const file = "scripts/windows/connect-homeoffice-calibration.mjs";
const source = fs.readFileSync(file, "utf8");
const cmd = fs.readFileSync(
  "scripts/windows/CONNECT-CALIBRATION-PRO.cmd",
  "utf8",
);

function example() {
  return {
    id: "kmj-homeoffice-desktop-5fvjmet",
    tenant: "approved-tenant_1",
    gateway: "https://kmjtechno.com/",
    token: "x".repeat(32),
    stateDir: path.join(os.tmpdir(), "kmj", "private", "state"),
    projects: [
      {
        id: "kmj-calibration-pro",
        root: path.join(os.tmpdir(), "kmj", "calibration"),
      },
    ],
  };
}

test("existing private Home Office identity and project are exact-scoped", () => {
  const valid = example();
  assert.equal(approvedScope(valid), true);
  for (const key of ["id", "tenant", "gateway", "stateDir"]) {
    const changed = structuredClone(valid);
    changed[key] = {
      id: "kmj-p720-desktop-k3ahhem",
      tenant: "tenant:evasion",
      gateway: "http://127.0.0.1:18787",
      stateDir: path.join(os.tmpdir(), "kmj", "public", "state"),
    }[key];
    assert.equal(approvedScope(changed), false, key);
  }
  const foreign = structuredClone(valid);
  foreign.projects[0].id = "kmj-cinecore";
  assert.equal(approvedScope(foreign), false);
  const dual = structuredClone(valid);
  dual.projects.push(dual.projects[0]);
  assert.equal(approvedScope(dual), false);
  const noSecret = structuredClone(valid);
  delete noSecret.token;
  assert.equal(approvedScope(noSecret), false);
  noSecret.gatewayTokenFile = path.join(
    os.tmpdir(),
    "kmj",
    "private",
    "bearer",
  );
  assert.equal(approvedScope(noSecret), true);
  noSecret.token = "y".repeat(32);
  assert.equal(approvedScope(noSecret), false);
});

test("private-path, process lock and untrusted ambiguity fail closed", () => {
  assert.equal(privatePath("C:\\KMJ\\private\\agent.json"), true);
  assert.equal(privatePath("/kmj/private/agent.json"), true);
  assert.equal(privatePath("/kmj/public/agent.json"), false);
  assert.equal(lockPid("12345"), 12345);
  assert.equal(lockPid('{"pid":7421,"owner":"test"}'), 7421);
  for (const bad of ["0", "-3", "garbage", '{"pid":0}', '{"pid":-5}']) {
    assert.equal(lockPid(bad), null);
  }
});

test("double click requires only Node, no PowerShell policy override", () => {
  assert.match(cmd, /node\.exe "%NODE_SCRIPT%"/);
  assert.match(cmd, /%~dp0connect-homeoffice-calibration\.mjs/);
  assert.doesNotMatch(cmd, /powershell|ExecutionPolicy|schtasks|curl|git clone/i);
  assert.match(source, /PUBLIC_GATEWAY_NOT_AUTH_PROTECTED/);
  assert.match(source, /response\.status !== 401/);
  assert.match(source, /EXISTING_ENROLLMENT_NOT_FOUND/);
  assert.match(source, /MULTIPLE_HOME_OFFICE_ENROLLMENTS/);
  assert.match(source, /GIT_ROOT_MISMATCH/);
  assert.match(source, /CALIBRATION_RECONNECT=LOCAL_AUTHENTICATED_HEARTBEAT/);
  assert.doesNotMatch(
    source,
    /execSync\(|shell: true|powershell\.exe|ExecutionPolicy|git reset|git clean|git pull|git clone|schtasks|setx|copyFileSync\(/i,
  );
});

test("wrong host never contacts gateway or reads private enrollment", () => {
  const check = spawnSync(process.execPath, [file, "--check-only"], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    env: { ...process.env, COMPUTERNAME: "OTHER-PC" },
  });
  assert.equal(check.status, 2);
  assert.match(check.stderr, /CALIBRATION_RECONNECT=BLOCKED_/);
  assert.doesNotMatch(check.stdout + check.stderr, /agent\.json|Bearer /i);
});
