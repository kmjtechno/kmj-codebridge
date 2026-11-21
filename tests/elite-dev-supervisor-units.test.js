import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/production/render-elite-dev-supervisor-units.py";
const SHA = "a".repeat(40);
const UNIT = "kmj-codebridge-dev-supervisor";
const NATIVE_PYTHON = process.platform !== "win32";

function render(...args) {
  return spawnSync("python3", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
}

test(
  "Elite dev Supervisor units are offline-only and bound to isolated kmjdev principal",
  { skip: !NATIVE_PYTHON },
  () => {
    const process = render("--source-sha", SHA);
    assert.equal(process.status, 0, process.stderr);
    const result = JSON.parse(process.stdout);
    assert.equal(result.mode, "OFFLINE_RENDER_ONLY");
    for (const key of [
      "installed",
      "operator_approved",
      "source_signed_and_verified",
      "runtime_identity_verified",
      "socket_acl_verified",
      "production_release_gate_credit",
    ]) {
      assert.equal(result[key], false, key);
    }
    assert.deepEqual(Object.keys(result.units).sort(), [
      UNIT + ".service",
      UNIT + ".socket",
    ]);

    const service = result.units[UNIT + ".service"];
    const socket = result.units[UNIT + ".socket"];
    assert.match(service, /^User=kmjdev$/m);
    assert.match(service, /^Group=kmjdev$/m);
    assert.match(service, /^Environment=KMJ_CODEBRIDGE_SUPERVISOR_PROFILE=codebridge-dev-elite$/m);
    assert.match(service, /^NoNewPrivileges=yes$/m);
    assert.match(service, /^ProtectSystem=strict$/m);
    assert.match(service, /^ProtectHome=yes$/m);
    assert.match(service, /^PrivateNetwork=yes$/m);
    assert.match(service, /^RestrictAddressFamilies=AF_UNIX$/m);
    assert.match(service, /^CapabilityBoundingSet=$/m);
    assert.match(service, /^AmbientCapabilities=$/m);
    assert.match(service, new RegExp("^WorkingDirectory=/opt/kmj-codebridge-dev-supervisor/" + SHA + "$", "m"));
    assert.match(service, new RegExp("^ExecStart=/opt/kmj-codebridge-node/bin/node /opt/kmj-codebridge-dev-supervisor/" + SHA + "/src/cli\\.js supervisor$", "m"));
    assert.doesNotMatch(service, /^User=root$/m);
    assert.doesNotMatch(service, /kmj-main-platform|kmj-cloudos|kmj-codebridge-supervisor\.socket/);
    assert.match(socket, /^ListenStream=\/run\/kmj-codebridge-dev\/supervisor\.sock$/m);
    assert.match(socket, /^SocketUser=kmjdev$/m);
    assert.match(socket, /^SocketGroup=kmjdev$/m);
    assert.match(socket, /^SocketMode=0600$/m);
    assert.match(socket, /^DirectoryMode=0711$/m);
    assert.match(socket, new RegExp("^Service=" + UNIT + "\\.service$", "m"));
    assert.doesNotMatch(socket, /\/run\/kmj-codebridge\/supervisor\.sock/);
    assert.doesNotMatch(socket, /\/run\/kmj-codebridge-cloudos\/supervisor\.sock/);
    assert.doesNotMatch(
      JSON.stringify(result),
      /sudo|systemctl (?:enable|start|restart)|chmod 777|chmod 666/,
    );
  },
);

test(
  "Elite dev unit renderer requires immutable source SHA and fixed root-managed Node",
  { skip: !NATIVE_PYTHON },
  () => {
    for (const sha of [
      "",
      "main",
      "a".repeat(39),
      "../" + SHA,
      "A".repeat(40),
      SHA + "/../escape",
    ]) {
      const result = render("--source-sha", sha);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
    }
    for (const node of [
      "/bin/sh",
      "/tmp/node",
      "/home/kmjdev/node",
      "/usr/local/bin/node",
    ]) {
      const result = render("--source-sha", SHA, "--node", node);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
    }
    const noArgs = render();
    assert.notEqual(noArgs.status, 0);
    assert.equal(noArgs.stdout, "");
  },
);

test(
  "Elite dev unit renderer permits the second fixed root-managed Node alternative only",
  { skip: !NATIVE_PYTHON },
  () => {
    const result = render("--source-sha", SHA, "--node", "/usr/bin/node");
    assert.equal(result.status, 0, result.stderr);
    const service = JSON.parse(result.stdout).units[UNIT + ".service"];
    assert.match(service, /^ExecStart=\/usr\/bin\/node /m);
    assert.doesNotMatch(service, /^ExecStart=\/bin\/sh /m);
  },
);
