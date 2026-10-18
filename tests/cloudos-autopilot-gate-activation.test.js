import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(
  ROOT,
  "scripts/production/enable-google-cloudos-autopilot-gate.sh",
);
const source = fs.readFileSync(SCRIPT, "utf8");

test(
  "CloudOS isolated Autopilot operator script parses under Bash",
  { skip: process.platform === "win32" },
  () => {
    assert.doesNotThrow(() =>
      execFileSync("bash", ["-n", SCRIPT], {
        timeout: 10000,
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  },
);

test("requires the precise enrolled host, GCE VM and pinned release", () => {
  for (const marker of [
    "google-vps1",
    "instance-20260912-094732",
    "Metadata-Flavor: Google",
    "dea0a6e398cd4706ddc61e314174314b9a6f95ee",
    "AGENT_RELEASE_MISMATCH",
    "SERVICE_USER_CHANGED",
    "SERVICE_RUNTIME_CHANGED",
    "NODE24_REQUIRED",
  ]) {
    assert.ok(source.includes(marker), marker);
  }
  assert.match(source, /--noproxy '\*'/);
});

test("does not touch dirty checkout or enable unapproved workers", () => {
  assert.match(source, /'autopilotGateWorker'/);
  assert.match(source, /'gates':\['fast'\]/);
  assert.match(source, /'isolatedWorktree':True/);
  assert.match(source, /get\('autopilotRepairWorker'/);
  assert.match(source, /get\('autopilotLocalWorker'/);
  assert.match(source, /get\('autopilotCiWatch'/);
  assert.match(source, /state\.stat\(\)\.st_uid==pwd\.getpwnam\('info'\)\.pw_uid/);
  assert.match(source, /ACTIVE_OR_PENDING_QA|CONFIG_OR_JOB_GUARD_FAILED/);
  assert.match(source, /DISK_BELOW_8GIB/);
  assert.doesNotMatch(source, /(?:git reset|git clean|rm -rf|curl.*\|\s*(?:sh|bash))/);
  assert.doesNotMatch(source, /(?:systemctl (?:stop|disable)|git push|npm install)/);
});

test("validates complete new config, backs up, restarts and rolls back on failure", () => {
  const stages = [
    "AUTOPILOT_GATE_PREFLIGHT=PASS",
    "enrolledAgentSchema.parse(config)",
    "before_hash=",
    'BACKUP="$(dirname "$CONFIG")/.kmj-cloudos-gate-backup-',
    'mv -f -- "$STAGE" "$CONFIG"',
    'systemctl restart "$UNIT" || die SERVICE_RESTART_FAILED',
    "NEW_AGENT_HEARTBEAT_MISSING",
    "VERIFIED=1",
  ];
  let previous = -1;
  for (const marker of stages) {
    const position = source.indexOf(marker);
    assert.ok(position > previous, marker);
    previous = position;
  }
  assert.match(source, /AUTOPILOT_CONFIG_ROLLBACK=START/);
  assert.match(source, /install -o info -g info -m 0600 "\$BACKUP" "\$restore"/);
  assert.match(source, /BACKUP_KEPT_FOR_ROLLBACK=YES/);
});
