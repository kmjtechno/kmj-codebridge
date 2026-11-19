import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  PIPE_NAME,
  RELEASE,
  TOKEN,
  validatePinnedConfig,
  validateStatus,
  probePersistent,
} from "../scripts/windows/P520-PERSISTENT-HMAC-VERIFY-20261119.mjs";

function config() {
  return {
    pipeName: PIPE_NAME,
    tokenFile: TOKEN,
    agent: {
      installDir: RELEASE,
      configPath: "C:\\Users\\Owner\\private\\agent.json",
    },
    projects: [],
    readOnlyProjects: [],
  };
}
function status() {
  return {
    supervisor: "windows-native",
    service: "agent",
    platform: "win32",
    restart: { supported: false },
    update: { supported: false },
    activeProcessRuntime: { verified: false },
    runtimeScope: "configured-install-dir",
  };
}
const opts = () => ({
  platform: "win32",
  hostname: "DESKTOP-5FVJMET",
  getConfig: () => config(),
  checkFiles: () => {},
  request: async ({ op }) => (op === "status" ? status() : { valid: true }),
});

test("persistent verifier accepts only pinned read-only P520 HMAC results", async () => {
  assert.deepEqual(await probePersistent(opts()), {
    verified: true,
    limitedCapabilities: true,
  });
});

test("persistent verifier refuses wrong host and OS before touching files", async () => {
  for (const change of [{ platform: "linux" }, { hostname: "DESKTOP-OTHER" }]) {
    let called = false;
    await assert.rejects(
      probePersistent({
        ...opts(),
        ...change,
        checkFiles: () => {
          called = true;
        },
      }),
      /WRONG_P520_DEVICE/,
    );
    assert.equal(called, false);
  }
});

test("persistent verifier rejects modified capabilities and endpoints", () => {
  for (const change of [
    (c) => {
      c.pipeName = "other";
    },
    (c) => {
      c.tokenFile = "C:\\unsafe";
    },
    (c) => {
      c.agent.installDir = "C:\\elsewhere";
    },
    (c) => {
      c.agent.restartTask = "Any";
    },
    (c) => {
      c.agent.configPath = "";
    },
    (c) => {
      c.projects.push("kmj-main-platform");
    },
    (c) => {
      c.readOnlyProjects.push("kmj-main-platform");
    },
  ]) {
    const c = config();
    change(c);
    assert.throws(
      () => validatePinnedConfig(c),
      /CONFIG_CAPABILITY_OR_IDENTITY_MISMATCH/,
    );
  }
  assert.throws(() => validatePinnedConfig(null), /CONFIG_FORMAT/);
});

test("persistent verifier requires exact HMAC service identity and disabled mutation", () => {
  assert.equal(validateStatus(status()), true);
  for (const change of [
    (s) => {
      s.supervisor = "fake";
    },
    (s) => {
      s.service = "gateway";
    },
    (s) => {
      s.platform = "linux";
    },
    (s) => {
      s.restart.supported = true;
    },
    (s) => {
      s.update.supported = true;
    },
    (s) => {
      s.activeProcessRuntime.verified = true;
    },
    (s) => {
      s.runtimeScope = "unverified";
    },
  ]) {
    const s = status();
    change(s);
    assert.throws(() => validateStatus(s), /HMAC_STATUS_NOT_ATTESTED/);
  }
});

test("persistent verifier refuses invalid config attestation", async () => {
  await assert.rejects(
    probePersistent({
      ...opts(),
      request: async ({ op }) =>
        op === "status" ? status() : { valid: false },
    }),
    /HMAC_CONFIG_NOT_VALID/,
  );
  await assert.rejects(
    probePersistent({
      ...opts(),
      request: async () => ({ ok: true }),
    }),
    /HMAC_STATUS_NOT_ATTESTED/,
  );
});

test("activation script is exact-existing-task, rollback-only, and no agent or release rewrite", () => {
  const src = fs.readFileSync(
    new URL(
      "../scripts/windows/P520-GUARDED-SUPERVISOR-ACTIVATE-20261119.ps1",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(src, /param\(\[switch\]\$Apply\)/);
  assert.match(src, /P520-SUPERVISOR-EXISTING-TASK-DOCTOR-20261118\.ps1/);
  assert.match(src, /P520-SUPERVISOR-EPHEMERAL-HMAC-LAUNCH-20261118\.ps1/);
  assert.match(src, /P520-PERSISTENT-HMAC-VERIFY-20261119\.mjs/);
  assert.match(src, /P520_EXISTING_TASK_DISABLED=PASS/);
  assert.match(src, /P520_HMAC_REJECTS_BAD_MAC=PASS/);
  assert.match(src, /P520_TOKEN_ACL=PASS/);
  assert.match(src, /P520_PINNED_RELEASE=PASS/);
  assert.match(src, /TASK_PRINCIPAL_OWNER_MISMATCH/);
  assert.match(src, /TASK_RUNLEVEL_CHANGED/);
  assert.match(src, /TASK_LOGON_TYPE_CHANGED/);
  assert.match(src, /if\(-not \$Apply\)/);
  assert.match(src, /Enable-ScheduledTask -TaskName \$taskName/);
  assert.match(src, /Start-ScheduledTask -TaskName \$taskName/);
  assert.match(src, /Disable-ScheduledTask -TaskName \$taskName/);
  assert.match(src, /P520_AGENT_BINDING' 'NOT_CHANGED'/);
  assert.match(src, /P520_PHYSICAL_RESTORE' 'NOT_EXECUTED'/);
  assert.match(src, /PRODUCTION_APPROVAL' 'NOT_GRANTED'/);
  assert.doesNotMatch(
    src,
    /\b(?:Register-ScheduledTask|Unregister-ScheduledTask|New-ScheduledTask|Set-ScheduledTask|Set-Content|Copy-Item|Remove-Item|Set-Acl|git\s+reset|git\s+clean)\b/i,
  );
});
