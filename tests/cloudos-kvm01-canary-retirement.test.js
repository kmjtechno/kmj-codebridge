import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(
  root,
  "scripts/production/retire-google-cloudos-kvm01-canary.py",
);
const source = fs.readFileSync(script, "utf8");

test(
  "Python retirement canary parses and exposes only an explicit --apply mode",
  { skip: process.platform === "win32" },
  () => {
    assert.doesNotThrow(() =>
      execFileSync(
        "python3",
        [
          "-B",
          "-c",
          "import ast,sys; ast.parse(open(sys.argv[1]).read())",
          script,
        ],
        { cwd: root, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  },
);

test("CloudOS nspawn retirement does not touch LXD or other guests", () => {
  assert.match(source, /NAME = "kvm01"/);
  assert.match(source, /HOST = "google-vps1"/);
  assert.match(source, /instance-20260912-094732/);
  assert.match(source, /parser\.add_argument\("--apply", action="store_true"/);
  assert.match(source, /if not args\.apply:\s*return 0/);
  assert.doesNotMatch(source, /lxc.*(?:delete|stop|restart|exec)/i);
  assert.doesNotMatch(source, /rm\s+-rf/);
  assert.doesNotMatch(source, /--force/);
  assert.doesNotMatch(source, /\bvirsh\b/);
  for (const service of [
    "kmj-cloudos-api.service",
    "kmj-cloudos-worker.service",
    "kmj-codebridge-cloudos.service",
  ])
    assert.ok(source.includes(service));
});

test("retirement must stop, test health, verify backup before one image removal", () => {
  const order = [
    "identity()",
    "if not args.apply:",
    'run(["systemctl", "stop", UNIT]',
    "healthy()",
    "archive = backup_guest(dest)",
    "dependency_guard()",
    "healthy()",
    'run(["machinectl", "remove", NAME]',
    "removed = True",
    "healthy()",
    "CANARY_RETIREMENT=PASS",
  ];
  let last = -1;
  for (const marker of order) {
    const next = source.indexOf(marker, last + 1);
    assert.ok(next > last, marker);
    last = next;
  }
  for (const marker of [
    "ARCHIVE_UNSAFE_ENTRY",
    "ARCHIVE_INCOMPLETE",
    "LOCAL_BACKUP_VALIDATED=YES",
    "MIN_FREE_AFTER_BACKUP",
    "GUEST_SYSTEMD_JOB_ACTIVE",
    "LIVE_SERVICE_REFERENCES_GUEST",
    "NESTED_GUEST_MOUNT_PRESENT",
    "CANARY_ROLLBACK=GUEST_RUNNING",
    "CANARY_RETIREMENT=BLOCKED_OR_ROLLED_BACK",
    "BACKUP_BASE_PERMISSIONS_UNSAFE",
    "INSUFFICIENT_BACKUP_HEADROOM",
    "FURTHER_GUEST_REMOVALS=REQUIRE_SEPARATE_QUALIFICATION",
  ])
    assert.ok(source.includes(marker), marker);
  assert.ok(
    source.indexOf("stopped = True") <
      source.indexOf('run(["systemctl", "stop", UNIT]'),
    "must attempt rollback even when stop times out",
  );
});
