import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const src = fs.readFileSync(
  "scripts/production/owner-trigger-signed-update-20261103.sh",
  "utf8",
);

test("ELITE fixed-owner trigger never falls back to development updater", () => {
  for (const fixed of [
    "ROOT_REQUIRED",
    "WRONG_HOST",
    "kmj-codebridge-stable-update.service",
    "/etc/kmj-codebridge-update/stable-update.json",
    "SIGNED_UNIT_PATH_UNVERIFIED",
    "SIGNED_UNIT_BUSY",
    "TRUST_OR_CONFIG_NOT_READY",
    "CODEBRIDGE_ACTIVATION=RECHECK_LIVE_RELEASE_SHA_AND_OAUTH",
  ]) {
    assert.ok(src.includes(fixed), fixed);
  }
  assert.ok(!src.includes("kmj-codebridge-auto-update.service"));
  assert.ok(!src.includes("systemctl enable"));
  assert.ok(!src.includes("daemon-reload"));
  assert.ok(!src.includes("systemctl restart"));
  assert.ok(!src.includes("StrictHostKeyChecking=no"));
  assert.ok(!src.includes("curl "));
  assert.ok(!src.includes("git pull"));
  assert.ok(!src.includes("eval "));
});

test("signed release preflight checks root-owned trust, no secrets printed", () => {
  for (const word of [
    "os.O_NOFOLLOW",
    "stat.S_ISREG",
    "st_nlink != 1",
    "manifestUrl",
    "signatureUrl",
    "trustedKeys",
    "PRIVATE KEY",
    "installRoot",
    "stateDir",
    "agentStateDir",
  ]) {
    assert.ok(src.includes(word), word);
  }
  assert.ok(
    src.includes(
      '[[ "$result" == success && "$code" == 0 && "$condition" == yes ]]',
    ),
  );
  assert.ok(!src.includes('cat "$CONFIG"'));
  assert.ok(!src.includes("print(obj)"));
});

test(
  "shell passes bash syntax; unprivileged attempt cannot execute systemctl start",
  { skip: process.platform === "win32" },
  () => {
    const syntax = spawnSync(
      "bash",
      ["-n", "scripts/production/owner-trigger-signed-update-20261103.sh"],
      { encoding: "utf8" },
    );
    assert.equal(syntax.status, 0, syntax.stderr);
    if (process.getuid?.() !== 0) {
      const run = spawnSync(
        "bash",
        ["scripts/production/owner-trigger-signed-update-20261103.sh"],
        { encoding: "utf8", timeout: 6000 },
      );
      assert.equal(run.status, 2, run.stdout + run.stderr);
      assert.match(run.stdout, /BLOCKED:ROOT_REQUIRED/);
    }
  },
);
