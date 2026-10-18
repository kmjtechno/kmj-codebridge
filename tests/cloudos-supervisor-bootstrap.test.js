import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "scripts/production/bootstrap-google-cloudos-supervisor.sh");
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
  assert.match(source, /npm=.*command -v npm/);
  assert.match(source, /--ignore-scripts --no-audit --no-fund/);
  assert.match(source, /find "\$STAGE" -type f -exec chmod 0444/);
  assert.match(source, /ProtectHome=tmpfs/);
  assert.match(source, /BindReadOnlyPaths=\/home\/info\/\.config\/kmj-codebridge \/home\/info\/kmj-cloudos/);
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
