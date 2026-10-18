import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(
  ROOT,
  "scripts/production/upgrade-google-cloudos-user-agent.sh",
);
const source = fs.readFileSync(SCRIPT, "utf8");

test(
  "CloudOS upgrade script parses on supported Linux hosts",
  {
    skip: process.platform === "win32",
  },
  () => {
    assert.doesNotThrow(() =>
      execFileSync("bash", ["-n", SCRIPT], {
        cwd: ROOT,
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  },
);

test("CloudOS upgrade is fixed-host, pinned and preserves the agent enrollment", () => {
  for (const text of [
    "kmj-codebridge-cloudos.service",
    "google-vps1",
    "/home/info/.config/kmj-codebridge/agent.json",
    "6e3a024797c6389e6a127c28d5b58dc8c016f9d5",
    "https://github.com/kmjtechno/kmj-codebridge.git",
    "check_jobs",
    "SOURCE_SHA_MISMATCH",
    "CLOUDOS_CHECKOUT_UNCHANGED=YES",
    "FRESH_GATEWAY_HEARTBEAT_MISSING",
    "AGENT_RUNTIME_ROLLBACK=START",
    "CLOUDOS_SERVICES_NOT_ACTIVE_PRE",
    "CLOUDOS_SERVICES_NOT_ACTIVE_POST",
  ])
    assert.ok(source.includes(text), text);
  assert.match(source, /git -C "\$STAGE" checkout -q --detach "\$PIN"/);
  assert.match(source, /runuser -u "\$AGENT_USER"/);
  for (const operation of [
    'rev-parse HEAD',
    'remote get-url origin',
    'status --porcelain --untracked-files=no',
  ]) {
    assert.ok(
      source.includes(
        'runuser -u "$AGENT_USER" -- git -C "$STAGE" ' + operation,
      ),
      "stage Git must run as unprivileged agent: " + operation,
    );
  }

  assert.match(source, /CONFIG_SHA=/);
  assert.doesNotMatch(source, /(?:rm -rf|git reset|git clean).*kmj-cloudos/);
  assert.doesNotMatch(source, /curl\s*\|\s*bash/);
  assert.doesNotMatch(source, /systemctl (enable|disable).*supervisor/);
  assert.match(source, /cloudos_services_healthy\(\)/);
  assert.match(source, /kmj-cloudos-api\.service kmj-cloudos-worker\.service/);
  assert.ok(
    source.indexOf("CLOUDOS_SERVICES_NOT_ACTIVE_PRE") <
      source.indexOf('mv -- "$RUNTIME" "$BACKUP"'),
  );
  assert.ok(
    source.indexOf("CLOUDOS_SERVICES_NOT_ACTIVE_POST") <
      source.indexOf("VERIFIED=1"),
  );
});

test("new runtime goes live only after exact-source check, all tests and backup", () => {
  const actions = [
    "SOURCE_SHA_MISMATCH",
    "run check || die CHECK_FAILED",
    "test || die TEST_FAILED",
    'mv -- "$RUNTIME" "$BACKUP"',
    'mv -- "$STAGE" "$RUNTIME"',
    'systemctl restart "$UNIT"',
    "FRESH_GATEWAY_HEARTBEAT_MISSING",
    "VERIFIED=1",
  ];
  let last = -1;
  for (const marker of actions) {
    const next = source.indexOf(marker);
    assert.ok(next > last, "sequence/order guard " + marker);
    last = next;
  }
});
