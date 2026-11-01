import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/production/render-elite-cloudos-supervisor-units.py";
const SHA = "a".repeat(40);
const UNIT = "kmj-codebridge-cloudos-elite-supervisor";
const NATIVE_PYTHON = process.platform !== "win32";

function render(...args) {
  return spawnSync("python3", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
}

test(
  "Elite CloudOS systemd unit render is source-only, non-root, and project-scoped",
  { skip: !NATIVE_PYTHON },
  () => {
    const process = render("--source-sha", SHA);
    assert.equal(process.status, 0, process.stderr);
    const result = JSON.parse(process.stdout);
    assert.equal(result.mode, "OFFLINE_RENDER_ONLY");
    assert.equal(result.installed, false);
    assert.equal(result.approved, false);
    assert.equal(result.runtime_verified, false);
    assert.equal(result.release_gate_credit, false);
    assert.deepEqual(Object.keys(result.units).sort(), [
      UNIT + ".service",
      UNIT + ".socket",
    ]);
    const service = result.units[UNIT + ".service"];
    const socket = result.units[UNIT + ".socket"];
    assert.match(service, /^User=kmjcloudosdev$/m);
    assert.match(service, /^Group=kmjcloudosdev$/m);
    assert.match(service, /^Environment=KMJ_CODEBRIDGE_SUPERVISOR_PROFILE=cloudos-elite$/m);
    assert.match(service, /^NoNewPrivileges=yes$/m);
    assert.match(service, /^ProtectSystem=strict$/m);
    assert.match(service, /^ProtectHome=yes$/m);
    assert.match(service, /^RestrictAddressFamilies=AF_UNIX$/m);
    assert.match(service, /^PrivateNetwork=yes$/m);
    assert.match(service, new RegExp(SHA));
    assert.doesNotMatch(service, /^User=root$/m);
    assert.doesNotMatch(service, /kmj-main-platform|kmj-codebridge-supervisor\.socket/);
    assert.match(socket, /^ListenStream=\/run\/kmj-codebridge-cloudos\/supervisor\.sock$/m);
    assert.match(socket, /^SocketUser=kmjcloudosdev$/m);
    assert.match(socket, /^SocketMode=0600$/m);
    assert.match(socket, /^DirectoryMode=0711$/m);
    assert.doesNotMatch(socket, /\/run\/kmj-codebridge\/supervisor\.sock/);
    assert.doesNotMatch(
      JSON.stringify(result),
      /sudo|systemctl (?:start|enable|restart)|chmod 777|chmod 666/,
    );
  },
);

test(
  "Elite CloudOS unit renderer rejects non-sha and caller chosen node binaries",
  { skip: !NATIVE_PYTHON },
  () => {
    for (const sha of ["main", "", "a".repeat(39), "../" + SHA, "A".repeat(40)]) {
      const result = render("--source-sha", sha);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
    }
    for (const node of ["/bin/sh", "/tmp/node", "/home/kmjcloudosdev/node"]) {
      const result = render("--source-sha", SHA, "--node", node);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
    }
  },
);
