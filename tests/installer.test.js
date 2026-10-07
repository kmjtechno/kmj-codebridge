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
  assert.match(
    script,
    /CODEBRIDGE_GATEWAY:-https:\/\/kmj-codebridge-gateway\.onrender\.com/,
  );
  assert.match(script, /CODEBRIDGE_ENROLLMENT_BASE/);
  assert.doesNotMatch(script, /CODEBRIDGE_AGENT_TOKEN/);
  assert.doesNotMatch(script, /github.*token/i);
  assert.doesNotMatch(
    script,
    /github\.com\/actions\/runner|config\.sh|runsvc\.sh/i,
  );
  assert.match(
    script,
    /No inbound VPS port or GitHub Actions runner is required/,
  );
});

test("installer verifies Node download and supports x64 plus arm64", () => {
  assert.match(script, /sha256sum -c/);
  assert.match(script, /x86_64\|amd64/);
  assert.match(script, /aarch64\|arm64/);
  assert.match(script, /24\.21\.0/);
  assert.match(script, /nodejs\.org\/download\/release/);
});

test("installer is idempotent and preserves valid enrollment on rerun", () => {
  assert.match(
    script,
    /Existing device enrollment found; preserving credential/,
  );
  assert.match(script, /have_config=1/);
  assert.match(script, /refusing automatic overwrite/);
  assert.match(script, /agent\.json\.rollback/);
  assert.match(script, /ROLLBACK_SERVICE/);
  assert.match(script, /bound to a different project/);
  assert.match(script, /\.rollback/);
});

test("installer stages updates and rolls back failed service or gateway verification", () => {
  assert.match(script, /INSTALL_DIR.*\.new/);
  assert.match(script, /rollback\(\)/);
  assert.match(script, /systemctl is-active --quiet/);
  assert.match(script, /EFFECTIVE_GATEWAY/);
  assert.match(script, /\/healthz/);
  assert.match(script, /connection\.json/);
  assert.match(script, /authenticated gateway request/);
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
  assert.doesNotMatch(script, /echo[^\n]*\$(?:TOKEN|CODEBRIDGE_AGENT_TOKEN)/i);
  assert.doesNotMatch(
    script,
    /printf[^\n]*\$(?:TOKEN|CODEBRIDGE_AGENT_TOKEN)/i,
  );
});

test("installer defines agent and supervisor unit rollback paths before use", () => {
  assert.match(script, /SERVICE_FILE="\/etc\/systemd\/system\/\$SERVICE"/);
  assert.match(
    script,
    /ROLLBACK_SERVICE="\$\{SERVICE_FILE\}\.rollback-codebridge"/,
  );
  assert.match(
    script,
    /SUPERVISOR_SERVICE_FILE="\/etc\/systemd\/system\/\$SUPERVISOR_SERVICE"/,
  );
  assert.match(
    script,
    /SUPERVISOR_SOCKET_FILE="\/etc\/systemd\/system\/\$SUPERVISOR_SOCKET_UNIT"/,
  );
  assert.match(script, /ROLLBACK_SUPERVISOR_SERVICE=/);
  assert.match(script, /ROLLBACK_SUPERVISOR_SOCKET=/);
});

test("installer provisions a restricted socket-activated supervisor", () => {
  assert.match(
    script,
    /SUPERVISOR_SOCKET_PATH="\/run\/kmj-codebridge\/supervisor\.sock"/,
  );
  assert.match(script, /supervisorSocket:process\.env\.SUPERVISOR_SOCKET_PATH/);
  assert.match(script, /ListenStream=\$SUPERVISOR_SOCKET_PATH/);
  assert.match(script, /SocketUser=\$SERVICE_USER/);
  assert.match(script, /SocketGroup=\$SERVICE_GROUP/);
  assert.match(script, /SocketMode=0600/);
  assert.match(script, /DirectoryMode=0711/);
  assert.match(
    script,
    /ExecStart=\$NODE \$INSTALL_DIR\/src\/cli\.js supervisor/,
  );
  assert.match(script, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(script, /systemctl enable "\$SUPERVISOR_SOCKET_UNIT"/);
  assert.match(script, /systemctl restart "\$SUPERVISOR_SOCKET_UNIT"/);
  assert.match(script, /supervisorRequest/);
  assert.match(script, /\{op:"status",service:"agent"\}/);
});

test("installer uses the enrollment-returned gateway for a fresh device and repairs an existing gateway", () => {
  assert.match(script, /typeof result\.gateway === "string"/);
  assert.match(script, /const gateway =/);
  assert.match(script, /result\.gateway/);
  assert.match(script, /: process\.env\.GATEWAY/);
  assert.match(script, /have_config == 1/);
  assert.match(script, /c\.gateway!==process\.env\.GATEWAY/);
});

test("installer migrates existing config without exposing or redirecting the supervisor", () => {
  assert.match(script, /unexpected supervisor socket/);
  assert.match(script, /c\.supervisorSocket=expected/);
  assert.match(script, /chmod 0600 "\$CONFIG"/);
  assert.match(script, /chown "\$SERVICE_USER:\$SERVICE_GROUP" "\$CONFIG"/);
  const supervisorEnvRefs = [
    ...script.matchAll(/supervisorSocket:\s*process\.env\.([A-Z_]+)/g),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(supervisorEnvRefs)], ["SUPERVISOR_SOCKET_PATH"]);
});

test("installer rollback restores or removes supervisor units consistently", () => {
  assert.match(script, /systemctl stop "\$SUPERVISOR_SERVICE"/);
  assert.match(script, /systemctl stop "\$SUPERVISOR_SOCKET_UNIT"/);
  assert.match(script, /ROLLBACK_SUPERVISOR_SERVICE/);
  assert.match(script, /ROLLBACK_SUPERVISOR_SOCKET/);
  assert.match(script, /SUPERVISOR_SOCKET_WAS_ENABLED/);
  assert.match(script, /systemctl disable --now "\$SUPERVISOR_SOCKET_UNIT"/);
});

test("installer wires signed stable updates with isolated root-owned trust state", () => {
  assert.match(
    script,
    /CODEBRIDGE_AUTO_UPDATE_MODE must be development, stable, beta or off/,
  );
  assert.match(
    script,
    /STABLE_CONFIG_DIR="\$\{CODEBRIDGE_STABLE_CONFIG_DIR:-\/etc\/kmj-codebridge-update\}"/,
  );
  assert.match(
    script,
    /STABLE_UPDATE_STATE_DIR="\$\{CODEBRIDGE_STABLE_UPDATE_STATE_DIR:-\/var\/lib\/kmj-codebridge-update\}"/,
  );
  assert.match(
    script,
    /STABLE_INSTALL_ROOT="\$\{CODEBRIDGE_STABLE_INSTALL_ROOT:-\/opt\/kmj-codebridge-stable\}"/,
  );
  assert.match(script, /Stable release trust keys must be root-owned/);
  assert.match(
    script,
    /Stable release trust keys must not be group\/world writable/,
  );
  assert.match(script, /agentStateDir: process\.env\.AGENT_STATE_DIR/);
  assert.match(script, /stateDir: process\.env\.STABLE_UPDATE_STATE_DIR/);
  assert.doesNotMatch(script, /stateDir:process\.env\.AGENT_STATE_DIR/);
});

test("agent service prefers the immutable signed current runtime with bootstrap fallback", () => {
  assert.match(
    script,
    /if \[ -L "\$STABLE_INSTALL_ROOT\/current" \] && \[ -f "\$STABLE_INSTALL_ROOT\/current\/src\/cli\.js" \]/,
  );
  assert.match(script, /runtime="\$INSTALL_DIR"/);
  assert.match(script, /runtime="\$STABLE_INSTALL_ROOT\/current"/);
  assert.match(
    script,
    /exec "\$NODE" "\\\$runtime\/src\/cli\.js" agent "\$CONFIG"/,
  );
});

test("installer provisions mutually exclusive development and signed stable timers", () => {
  assert.match(script, /kmj-codebridge-stable-update\.service/);
  assert.match(script, /kmj-codebridge-stable-update\.timer/);
  assert.match(script, /stable-update "\$STABLE_UPDATE_CONFIG"/);
  assert.match(script, /ConditionPathExists=\$STABLE_UPDATE_CONFIG/);
  assert.match(
    script,
    /ReadWritePaths=\$STABLE_INSTALL_ROOT \$STABLE_UPDATE_STATE_DIR \$STABLE_WORK_DIR/,
  );
  assert.match(script, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(
    script,
    /stable\|beta\)[\s\S]*disable --now "\$AUTO_UPDATE_TIMER"[\s\S]*enable --now "\$STABLE_UPDATE_TIMER"/,
  );
  assert.match(
    script,
    /development\)[\s\S]*disable --now "\$STABLE_UPDATE_TIMER"[\s\S]*enable --now "\$AUTO_UPDATE_TIMER"/,
  );
});

test("installer rollback includes signed stable updater units and config", () => {
  assert.match(script, /ROLLBACK_STABLE_UPDATE_SERVICE/);
  assert.match(script, /ROLLBACK_STABLE_UPDATE_TIMER/);
  assert.match(script, /ROLLBACK_STABLE_UPDATE_CONFIG/);
  assert.match(script, /STABLE_TIMER_WAS_ENABLED/);
  assert.match(script, /systemctl stop "\$STABLE_UPDATE_SERVICE"/);
  assert.match(script, /systemctl stop "\$STABLE_UPDATE_TIMER"/);
});

test("installer provisions fixed bounded stable rollback service", () => {
  assert.match(script, /kmj-codebridge-stable-rollback\.service/);
  assert.match(script, /stable-rollback "\$STABLE_UPDATE_CONFIG"/);
  assert.match(script, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(
    script,
    /ReadWritePaths=\$STABLE_INSTALL_ROOT \$STABLE_UPDATE_STATE_DIR/,
  );
});
