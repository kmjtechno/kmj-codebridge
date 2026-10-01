import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const script = fs.readFileSync("scripts/install-vps.sh", "utf8");

test("VPS installer is shell-valid on Linux", (t) => {
  if (process.platform === "win32") {
    t.skip("bash syntax check runs on Linux CI");
    return;
  }
  const checked = spawnSync("bash", ["-n", "scripts/install-vps.sh"], {
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr);
});

test("fresh installer uses secure enrollment and never requires manual agent token", () => {
  assert.match(script, /scripts\/enroll-device\.js/);
  assert.match(script, /CODEBRIDGE_ENROLLMENT_BASE/);
  assert.doesNotMatch(script, /CODEBRIDGE_AGENT_TOKEN/);
  assert.doesNotMatch(script, /github.*token/i);
  assert.doesNotMatch(script, /actions[-_. ]?runner/i);
  assert.match(script, /No inbound VPS port or GitHub Actions runner is required/);
});

test("installer verifies Node download and supports x64 plus arm64", () => {
  assert.match(script, /sha256sum -c/);
  assert.match(script, /x86_64\|amd64/);
  assert.match(script, /aarch64\|arm64/);
  assert.match(script, /24\.21\.0/);
  assert.match(script, /nodejs\.org\/download\/release/);
});

test("installer is idempotent and preserves valid enrollment on rerun", () => {
  assert.match(script, /Existing device enrollment found; preserving credential/);
  assert.match(script, /have_config=1/);
  assert.match(script, /refusing to overwrite it automatically/);
  assert.match(script, /agent\.json\.rollback/);
  assert.match(script, /\.rollback/);
});

test("installer stages updates and rolls back failed service or gateway verification", () => {
  assert.match(script, /INSTALL_DIR.*\.new/);
  assert.match(script, /rollback\(\)/);
  assert.match(script, /systemctl is-active --quiet/);
  assert.match(script, /oauth-protected-resource/);
  assert.match(script, /rolling back CodeBridge/);
});

test("installer writes a hardened boot-enabled systemd service", () => {
  assert.match(script, /systemctl enable/);
  assert.match(script, /NoNewPrivileges=true/);
  assert.match(script, /ProtectSystem=strict/);
  assert.match(script, /ProtectKernelTunables=true/);
  assert.match(script, /ProtectKernelModules=true/);
  assert.match(script, /ProtectControlGroups=true/);
  assert.match(script, /RestrictSUIDSGID=true/);
  assert.match(script, /LockPersonality=true/);
  assert.match(script, /UMask=0077/);
  assert.match(script, /Restart=always/);
});

test("installer binds an explicit or detected project and protects config", () => {
  assert.match(script, /--project/);
  assert.match(script, /Current directory does not look like a project/);
  assert.match(script, /chmod 0600 "\$CONFIG"/);
  assert.match(script, /ReadWritePaths=\$PROJECT \$STATE_DIR/);
});

test("installer never prints secret variables", () => {
  assert.doesNotMatch(script, /echo[^\n]*(TOKEN|credential)/i);
  assert.doesNotMatch(script, /printf[^\n]*(TOKEN|credential)/i);
});
