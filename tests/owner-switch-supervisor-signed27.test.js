import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const script = fs.readFileSync(
  "scripts/production/owner_switch_supervisor_signed27_20261115.py",
  "utf8",
);
const supervisor = fs.readFileSync("src/supervisor.js", "utf8");

test("supervisor switch moves seq21 (dc148773) to signed27 (40655678) only", () => {
  assert.match(script, /OLD_DIR = .*0\.3\.2-dc14877375a5"\)/);
  assert.match(script, /NEW_DIR = .*0\.3\.2-40655678db7f"\)/);
  assert.match(script, /UNIT = "kmj-codebridge-supervisor\.service"/);
  assert.doesNotMatch(script, /gateway-stage|stable-update|nginx/);
});

test("new drop-in sorts after every live Supervisor drop-in; backups are ignored", () => {
  const live = [
    "20-main-platform-production-readonly.conf",
    "99-kmj-reviewed-runtime.conf",
    "zzz-kmj-seq11-schema-parity.conf",
    "zzzz-kmj-signed14.conf",
    "zzzzz-kmj-dev-attestation-release.conf",
  ];
  const next = script.match(/NEW_CONF = DIR \/ "([^"]+)"/)[1];
  assert.equal([...live, next].sort().at(-1), next);
  assert.match(script, /n\.endswith\("\.conf"\)/);
});

test("the seq21 drop-in bytes the script requires match the live 142-byte file", () => {
  const bytes =
    "[Service]\nExecStart=\nExecStart=/opt/kmj-codebridge-node/bin/node " +
    "/opt/kmj-codebridge-stable/releases/0.3.2-dc14877375a5/src/cli.js supervisor\n";
  assert.equal(Buffer.byteLength(bytes), 142);
  assert.match(
    script,
    /"\[Service\]\\n"\n\s+"ExecStart=\\n"\n\s+f"ExecStart=\{NODE\} \{release_dir\}\/src\/cli\.js supervisor\\n"/,
  );
});

test("dry-run by default; never restarts, stops or kills the Supervisor", () => {
  assert.match(
    script,
    /sys\.argv\[1:\] in \(\[\], \["--apply"\], \["--rollback"\]\)/,
  );
  assert.match(
    script,
    /if sys\.argv\[1:\] != \["--apply"\]:\n\s+print\("SIGNED27_SUPERVISOR=DRY_RUN_UNCHANGED"\)/,
  );
  const calls = [...script.matchAll(/cmd\("systemctl", "([a-z-]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual([...new Set(calls)].sort(), ["daemon-reload", "show"]);
  assert.doesNotMatch(
    script,
    /os\.kill|signal\.|"restart"|"stop"|"start"|shell=True|os\.system/,
  );
});

test("root executes the new tree, so it must be root-owned and not writable by others", () => {
  for (const code of [
    "SIGNED27_TREE_NOT_ROOT_OWNED",
    "SIGNED27_TREE_WRITABLE_BY_NON_ROOT",
    "SIGNED27_TREE_SYMLINK_ESCAPES",
    "SIGNED27_CURRENT_POINTER_MISMATCH",
    "SEQ21_SUPERVISOR_OVERRIDE_DRIFT",
    "SUPERVISOR_NOT_ON_SEQ21",
    "DROPIN_ORDER_UNEXPECTED",
  ])
    assert.ok(script.includes(code), code);
});

test("the operations the script requires exist in this tree's Supervisor", () => {
  const block = script.match(/NEW_OPERATIONS = \(([^)]+)\)/)[1];
  const operations = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.equal(operations.length, 3);
  for (const operation of operations)
    assert.ok(supervisor.includes(`request.op === "${operation}"`), operation);
});

test("rollback and auto-rollback remove only the exact drop-in this script wrote", () => {
  assert.match(
    script,
    /if root_file\(NEW_CONF\) == content\(NEW_DIR\):\n\s+os\.unlink\(NEW_CONF\)/,
  );
  assert.match(
    script,
    /need\(root_file\(NEW_CONF\) == content\(NEW_DIR\), "SIGNED27_SUPERVISOR_OVERRIDE_DRIFT"\)/,
  );
  assert.equal(
    (script.match(/os\.unlink\((?!NEW_CONF|temp|LOCK)/g) ?? []).length,
    0,
  );
});
