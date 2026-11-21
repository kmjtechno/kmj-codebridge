import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyOwnerReleaseFolder } from "../scripts/verify-signed-owner-release.mjs";

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
    "dea0a6e398cd4706ddc61e314174314b9a6f95ee",
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
    "rev-parse HEAD",
    "remote get-url origin",
    "status --porcelain --untracked-files=no",
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

test("Google upgrade admits only the independently signed seq33 and fixed old runtime", () => {
  const oldPin = "dea0a6e398cd4706ddc61e314174314b9a6f95ee";
  const newPin = "9584b584c9a94545fb9dc750c9dfef5bf4f7978a";
  const m = verifyOwnerReleaseFolder(ROOT, newPin);
  assert.deepEqual(m, { sequence: 33, revision: newPin });
  for (const required of [
    "OLD_PIN=" + oldPin,
    "PIN=" + newPin,
    "RELEASE_METADATA_COMMIT=37c0669b08d6a3d04e346fa5532066a28ee27427",
    "OWNER_ED25519_SIGNED_SEQ33=PASS",
    "SIGNED_ARCHIVE_DIGEST=PASS",
    "OWNER_ED25519_RELEASE_UNVERIFIED",
    "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8",
    "1d19f0e2163fa764432c1612914fef5215ba30cdc26e87f9e41a28342d016bc7",
    "32320e772aa1167a8ddefbd036dd2b95c9bf565608426c624de4d01173742ca0",
    "OLD_RUNTIME_PIN_CHANGED",
    "CONFIG_MODE_CHANGED",
    "SUPERVISOR_SOCKET_UNVERIFIED",
    "SUPERVISOR_STATUS=EXISTING_SOCKET_LEFT_UNCHANGED",
  ])
    assert.ok(source.includes(required), required);
  assert.ok(
    source.indexOf("OWNER_ED25519_RELEASE_UNVERIFIED") <
      source.indexOf('mv -- "$RUNTIME" "$BACKUP"'),
  );
  assert.ok(
    source.indexOf("SIGNED_ARTIFACT_CLEANUP_FAILED") <
      source.indexOf('mv -- "$RUNTIME" "$BACKUP"'),
  );
  assert.doesNotMatch(
    source,
    /(?:systemctl restart|systemctl stop|systemctl enable).*kmj-codebridge-supervisor/,
  );
  assert.doesNotMatch(source, /(?:git reset|git clean|curl\s*\|\s*bash)/);
});
