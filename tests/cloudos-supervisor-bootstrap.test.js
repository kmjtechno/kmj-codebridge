import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(
  root,
  "scripts/production/bootstrap-google-cloudos-supervisor.sh",
);
const source = fs.readFileSync(file, "utf8");

test(
  "CloudOS Supervisor rootless-agent bootstrap parses under Bash",
  { skip: process.platform === "win32" },
  () => {
    assert.doesNotThrow(() => {
      execFileSync("bash", ["-n", file], {
        cwd: root,
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    });
  },
);

test("operator bootstrap is fenced to fixed GCE host and immutable source", () => {
  for (const marker of [
    "google-vps1",
    "instance-20260912-094732",
    "Metadata-Flavor: Google",
    "kmj-codebridge-cloudos.service",
    "fa9340b958ce50000298282d65f3132596c16503",
    "dea0a6e398cd4706ddc61e314174314b9a6f95ee",
    "NODE24_REQUIRED",
    "SOURCE_HEAD_CHANGED",
    "ROOT_STAGE_WRITABLE",
    "ROOT_STAGE_SYMLINK_ESCAPE",
    "BELOW_8GIB_DISK",
  ]) {
    assert.ok(source.includes(marker), marker);
  }
});

test("root Supervisor imports only staged root-owned pinned source", () => {
  assert.match(source, /git -C "\$STAGE".*checkout -q --detach "\$SOURCE_PIN"/);
  assert.match(source, /pick_root_node/);
  assert.match(source, /is_root_binary "\$dir\/node"/);
  assert.match(source, /is_root_binary "\$dir\/npm"/);
  assert.match(source, /env PATH="\$\(dirname "\$node"\):\$PATH" "\$npm"/);
  assert.match(source, /--ignore-scripts --no-audit --no-fund/);
  assert.match(source, /find "\$STAGE" -type f -exec chmod 0444/);
  assert.match(source, /ProtectHome=tmpfs/);
  assert.match(
    source,
    /BindReadOnlyPaths=\/home\/info\/\.config\/kmj-codebridge \/home\/info\/kmj-cloudos/,
  );
  assert.match(source, /Environment=KMJ_CODEBRIDGE_SUPERVISOR_PROFILE=cloudos/);
  assert.doesNotMatch(source, /(?:git reset|git clean|curl.*\|\s*(?:bash|sh))/);
});

test("existing enrollment and other services are preserved on failure", () => {
  assert.match(source, /EXISTING_SUPERVISOR_CONFLICT/);
  assert.match(source, /CONFIG_OR_BUSY_JOB_GUARD_FAILED/);
  assert.match(source, /chown info:info "\$NEWCFG"/);
  assert.match(source, /module\.enrolledAgentSchema\.parse\(obj\)/);
  assert.match(source, /SUPERVISOR_CONFIG_ROLLBACK=ATTEMPTED/);
  assert.match(source, /SUPERVISOR_NEW_UNITS_ROLLBACK=ATTEMPTED/);
  assert.match(source, /FRESH_AGENT_CONNECTION_NOT_VERIFIED/);
  assert.match(source, /CLOUDOS_SUPERVISOR_BOOTSTRAP=PASS/);
  assert.doesNotMatch(source, /systemctl restart kmj-cloudos-api/);
  assert.doesNotMatch(source, /systemctl restart kmj-cloudos-worker/);
});

test("socket is user-owned, private and profile-scoped", () => {
  assert.match(source, /SocketUser=info/);
  assert.match(source, /SocketMode=0600/);
  assert.match(source, /User=root/);
  assert.match(source, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(source, /runuser -u info -- python3/);
});

test("user-owned agent Node is never imported into the privileged process", () => {
  assert.match(source, /AGENT_PROCESS_IDENTITY_CHANGED/);
  assert.match(source, /split\(b"\\0"\)/);
  assert.doesNotMatch(source, /node=\$\(readlink -e "\/proc\/\$pid\/exe"\)/);
  assert.doesNotMatch(source, /chmod.*\/home\/info\/.*node/);
});

test("fallback provisions only checksum-pinned official root-managed Node 24", () => {
  assert.match(source, /node-v24\.21\.0-linux-\$node_arch/);
  assert.match(source, /https:\/\/nodejs\.org\/download\/release\/v24\.21\.0\/\$archive/);
  assert.match(
    source,
    /fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6/,
  );
  assert.match(
    source,
    /6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2/,
  );
  assert.match(source, /sha256sum -c - >\/dev\/null/);
  assert.match(source, /OFFICIAL_NODE_SHA256_MISMATCH/);
  assert.match(source, /ROOT_NODE24_BUNDLE_INVALID/);
  assert.match(source, /NODE_STAGE/);
  assert.match(source, /CLOUDOS_SUPERVISOR_ROOT_NODE=VERIFIED/);
});
