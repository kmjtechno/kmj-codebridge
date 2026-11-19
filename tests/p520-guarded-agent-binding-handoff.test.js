import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../scripts/windows/P520-GUARDED-AGENT-BINDING-HANDOFF-20261119.ps1", import.meta.url),
  "utf8",
);

test("P520 agent handoff dry-run is the default", () => {
  assert.match(source, /\bparam\(\[switch\]\$Apply\)/);
  assert.match(source, /if\(-not \$Apply\)/);
  assert.match(source, /P520_AGENT_HANDOFF_MODE' 'READ_ONLY'/);
  assert.match(source, /P520_AGENT_RESTART' 'NOT_EXECUTED'/);
  assert.match(source, /P520_PHYSICAL_RESTORE' 'NOT_EXECUTED'/);
  assert.match(source, /PRODUCTION_APPROVAL' 'NOT_GRANTED'/);
});

test("P520 handoff requires real current HMAC and exact existing-agent proposal", () => {
  assert.match(source, /P520-PERSISTENT-HMAC-VERIFY-20261119\.mjs/);
  assert.match(source, /P520-EXACT-AGENT-BINDING-PREFLIGHT-20261119\.mjs/);
  assert.match(source, /3bd126fb9901c91cf32dfdbdd4362bb29f37dc99bbc7da01a138674f6cc723a9/);
  assert.match(source, /e66d268f2e9a199a1d450c40b27249232c54d8ce179d6885a49371c676973b4d/);
  assert.match(source, /P520_PERSISTENT_HMAC_STATUS=PASS/);
  assert.match(source, /P520_AGENT_PROPOSAL_EXACT_ONLY=PASS/);
  assert.match(source, /SUPERVISOR_EXISTING_TASK_NOT_RUNNING/);
  assert.match(source, /AGENT_OWNER_SID_MISMATCH/);
  assert.match(source, /AGENT_PROCESS_NOT_UNIQUE/);
});

test("P520 handoff pins actual existing runtime and refuses dirty tracked source", () => {
  assert.match(source, /4f0a96ceba203315262da219d51b554e716355c9/);
  assert.match(source, /AGENT_RUNNING_SOURCE_SHA_MISMATCH/);
  assert.match(source, /AGENT_RUNNING_SOURCE_ORIGIN_MISMATCH/);
  assert.match(source, /AGENT_RUNNING_SOURCE_TRACKED_DIRTY/);
  assert.match(source, /AGENT_COMMANDLINE_UNTRUSTED/);
});

test("P520 handoff checks job idleness, atomic backup and heartbeat", () => {
  assert.match(source, /AGENT_JOB_INVENTORY_UNBOUNDED/);
  assert.match(source, /AGENT_BUSY/);
  assert.match(source, /AGENT_AUTOPILOT_ACTIVE/);
  assert.match(source, /\[IO\.File\]::Replace\(\$temp,\$config,\$backup\)/);
  assert.match(source, /AGENT_ATOMIC_BACKUP_SHA_MISMATCH/);
  assert.match(source, /AGENT_AUTORESTART_COLLISION/);
  assert.match(source, /ConfirmHeartbeat \$newPid/);
  assert.match(source, /P520_AGENT_RECONNECTED' 'PASS'/);
});

test("P520 handoff rollback restores original bytes and checks old heartbeat", () => {
  assert.match(source, /P520_AGENT_CONFIG_ROLLBACK' 'PASS'/);
  assert.match(source, /ROLLBACK_CONFIG_HASH_MISMATCH/);
  assert.match(source, /ROLLBACK_DUPLICATE_AGENT_PRESENT/);
  assert.match(source, /ROLLBACK_HEARTBEAT_UNVERIFIED/);
  assert.match(source, /P520_AGENT_ROLLBACK' 'FAILED_OWNER_RECOVERY_REQUIRED'/);
});

test("P520 handoff never registers new task, enrolls device, touches main platform or keys", () => {
  assert.doesNotMatch(
    source,
    /\b(?:Register-ScheduledTask|Unregister-ScheduledTask|New-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask|Set-ScheduledTask|git\s+reset|git\s+clean|New-Service|Set-Service)\b/i,
  );
  assert.doesNotMatch(source, /ssh(?:\.exe)?\b|scp(?:\.exe)?\b|ALTER DATABASE|pg_restore|APPROVED_PRODUCTION_RELEASE/);
});
