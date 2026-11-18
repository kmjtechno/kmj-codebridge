import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const service = fs.readFileSync(
  "scripts/production/systemd/kmj-codebridge-signed-feed-roll.service",
  "utf8",
);
const timer = fs.readFileSync(
  "scripts/production/systemd/kmj-codebridge-signed-feed-roll.timer",
  "utf8",
);
const trip = fs.readFileSync(
  "scripts/production/systemd/kmj-codebridge-signed-feed-roll-trip.service",
  "utf8",
);
const publisher = fs.readFileSync(
  "scripts/production/owner_roll_signed_latest_feed_20261115.py",
  "utf8",
);

function field(source, key) {
  const matching = source
    .split(/\r?\n/)
    .filter((line) => line.startsWith(key + "="));
  assert.equal(matching.length, 1, key + " must occur exactly once");
  return matching[0].slice(key.length + 1);
}

test("signed feed publisher timer is opt-in, hourly and fixed to the reviewed unit", () => {
  assert.equal(field(timer, "OnCalendar"), "hourly");
  assert.equal(field(timer, "RandomizedDelaySec"), "5min");
  assert.equal(field(timer, "Persistent"), "true");
  assert.equal(field(timer, "Unit"), "kmj-codebridge-signed-feed-roll.service");
  assert.equal(field(timer, "WantedBy"), "timers.target");
  assert.doesNotMatch(
    timer,
    /ExecStart|Environment|WantedBy=multi-user.target|RemainAfterExit/i,
  );
});

test("signed feed service is a hardened, fixed-path root oneshot only", () => {
  for (const [key, expected] of Object.entries({
    Type: "oneshot",
    User: "root",
    Group: "root",
    UMask: "0077",
    NoNewPrivileges: "true",
    PrivateTmp: "true",
    PrivateDevices: "true",
    ProtectSystem: "strict",
    ProtectHome: "true",
    ProtectControlGroups: "true",
    ProtectKernelModules: "true",
    ProtectKernelTunables: "true",
    ProtectKernelLogs: "true",
    RestrictSUIDSGID: "true",
    LockPersonality: "true",
    SystemCallArchitectures: "native",
    ReadWritePaths: "/var/lib/kmj-codebridge-releases/stable",
    CapabilityBoundingSet: "",
    AmbientCapabilities: "",
    ExecStart:
      "/usr/bin/python3 -I -B /usr/local/libexec/kmj-codebridge/owner_roll_signed_latest_feed_20261115.py --apply --confirm-owner-signed-rolling-feed",
    TimeoutStartSec: "15min",
  })) {
    assert.equal(field(service, key), expected, key);
  }
  assert.equal((service.match(/^ConditionFileNotEmpty=/gm) ?? []).length, 2);
  assert.match(
    service,
    /^ConditionFileNotEmpty=\/etc\/kmj-codebridge-update\/stable-update\.json$/m,
  );
  assert.match(
    service,
    /^ConditionPathIsDirectory=\/var\/lib\/kmj-codebridge-releases\/stable$/m,
  );
  assert.doesNotMatch(
    service,
    /ExecStartPre|ExecStartPost|EnvironmentFile|WorkingDirectory|\/bin\/(?:bash|sh)|git pull|git reset|curl.*\|.*bash/,
  );
});

test("publication failure trips only the fixed feed timer, never the agent", () => {
  assert.equal(
    field(service, "OnFailure"),
    "kmj-codebridge-signed-feed-roll-trip.service",
  );
  assert.equal(field(trip, "Type"), "oneshot");
  assert.equal(field(trip, "User"), "root");
  assert.equal(field(trip, "Group"), "root");
  assert.equal(field(trip, "ProtectSystem"), "strict");
  assert.equal(field(trip, "NoNewPrivileges"), "true");
  assert.equal(field(trip, "RestrictAddressFamilies"), "AF_UNIX");
  assert.equal(field(trip, "CapabilityBoundingSet"), "");
  assert.equal(field(trip, "AmbientCapabilities"), "");
  assert.equal(
    field(trip, "ExecStart"),
    "/usr/bin/systemctl disable --now kmj-codebridge-signed-feed-roll.timer",
  );
  assert.doesNotMatch(
    trip,
    /ExecStartPre|ExecStartPost|EnvironmentFile|\/bin\/(?:sh|bash)|git pull|rm -rf|stable-update\.timer/,
  );
});

test(
  "native systemd unit parser accepts all three publisher unit definitions",
  { skip: process.platform !== "linux" },
  () => {
    const check = spawnSync(
      "systemd-analyze",
      [
        "verify",
        "scripts/production/systemd/kmj-codebridge-signed-feed-roll.service",
        "scripts/production/systemd/kmj-codebridge-signed-feed-roll.timer",
        "scripts/production/systemd/kmj-codebridge-signed-feed-roll-trip.service",
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    if (check.error?.code === "ENOENT") return;
    assert.equal(check.status, 0, check.stderr || String(check.error));
    assert.doesNotMatch(
      check.stderr,
      /Unknown key|Unknown lvalue|Failed to parse|Invalid argument/i,
    );
  },
);

test("periodic publisher is signed-only, monotonic, atomically reversible", () => {
  for (const gate of [
    "OWNER_SPKI",
    "verify_signature(",
    "SIGNED_SEQUENCE_ROLLBACK",
    "SIGNED_SEQUENCE_EQUIVOCATION",
    "PUBLIC_SIGNED_BYTES_MISMATCH",
    "SIGNED_ARCHIVE_SHA_MISMATCH",
    "RENAME_EXCHANGE",
    "SIGNED_FEED_ROLLBACK_UNPROVEN",
    "PUBLIC_READBACK_FAILED_PREVIOUS_FEED_RESTORED",
    "--confirm-owner-signed-rolling-feed",
  ]) {
    assert.ok(publisher.includes(gate), gate);
  }
  assert.doesNotMatch(
    publisher,
    /shell\s*=\s*True|git\s+pull|git\s+reset|owner_private_key/,
  );
});
