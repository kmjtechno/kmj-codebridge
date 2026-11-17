import test from "node:test";
import { createSupervisorHandler } from "../src/supervisor.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  EXIT3_DIAGNOSTIC_PATH, EXIT3_DIAGNOSTIC_SHA256,
  EXIT3_DIAGNOSTIC_CONFIRMATION, parseExit3Diagnostic, runExit3Diagnostic,
} from "../src/offsite-exit3-diagnostic-policy.js";

const SCRIPT = readFileSync(new URL("./fixtures/diagnose-offsite-exit3-20261117.py", import.meta.url), "utf8");
const GOOD = [
  "KMJ_OFFSITE_EXIT3=READ_ONLY_CLASSIFIED",
  "SYSTEMD_EXIT=3",
  "JOURNAL_SCOPE=EXACT_INVOCATION",
  "FAILURE_CLASS=REMOTE_NETWORK_OR_DNS",
  "RAW_JOURNAL_EXPOSED=NO",
  "BACKUP_REPAIR=NOT_ATTEMPTED",
  "OFFHOST_BACKUP_VERIFIED=NO",
  "PRODUCTION_APPROVAL=UNCHANGED",
].join("\n") + "\n";
const file = (extra = {}) => ({
  uid: 0, nlink: 1, mode: 0o100500, size: Buffer.byteLength(SCRIPT),
  isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
  ...extra,
});
const dir = (extra = {}) => ({
  uid: 0, mode: 0o40755,
  isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
  ...extra,
});
function harness({ source = SCRIPT, output = GOOD, failure = false,
                    fileValue = file(), dirValue = dir(),
                    after = source } = {}) {
  const executions = [];
  let reads = 0;
  const run = (...args) => {
    executions.push(args);
    if (failure) throw Error("a sensitive /root/.ssh/id key");
    return output;
  };
  const lstat = (path) => path === EXIT3_DIAGNOSTIC_PATH ? fileValue : dirValue;
  const readFile = (path) => {
    assert.equal(path, EXIT3_DIAGNOSTIC_PATH);
    return ++reads === 1 ? source : after;
  };
  return { executions, run: () => runExit3Diagnostic({ run, lstat, readFile }) };
}
test("source is byte-for-byte reviewed Main Platform PR890, no accidental re-pin", () => {
  assert.equal(createHash("sha256").update(SCRIPT).digest("hex"), EXIT3_DIAGNOSTIC_SHA256);
  assert.equal(EXIT3_DIAGNOSTIC_CONFIRMATION, "RUN_FIXED_READONLY_OFFSITE_EXIT3_DIAGNOSTIC");
  assert.equal(EXIT3_DIAGNOSTIC_PATH,
    "/usr/local/libexec/kmj-main-platform-diagnose-offsite-exit3-20261117.py");
  assert.ok(!SCRIPT.includes("systemctl restart"));
  assert.ok(!SCRIPT.includes("journalctl -u"));
});
test("accepts only fixed categorical stdout, never raw journal", () => {
  const parsed = parseExit3Diagnostic(GOOD);
  assert.deepEqual(Object.keys(parsed), ["execMainStatus", "journalScope", "failureClass"]);
  assert.equal(parsed.failureClass, "REMOTE_NETWORK_OR_DNS");
  for (const unsafe of [
    "", GOOD + "LEAK=secret\n", GOOD.replace("SYSTEMD_EXIT=3", "SYSTEMD_EXIT=255"),
    GOOD.replace("JOURNAL_SCOPE=EXACT_INVOCATION", "JOURNAL_SCOPE=UNAVAILABLE"),
    GOOD.replace("BACKUP_REPAIR=NOT_ATTEMPTED", "BACKUP_REPAIR=PASS"),
    GOOD.replace("PRODUCTION_APPROVAL=UNCHANGED", "PRODUCTION_APPROVAL=GRANTED"),
    GOOD.replace("FAILURE_CLASS=REMOTE_NETWORK_OR_DNS", "FAILURE_CLASS=/root/token"),
    GOOD.replace("RAW_JOURNAL_EXPOSED=NO", "RAW_JOURNAL_EXPOSED=YES"),
    GOOD.replace("OFFHOST_BACKUP_VERIFIED=NO", "OFFHOST_BACKUP_VERIFIED=PASS"),
    GOOD.replace("FAILURE_CLASS=REMOTE_NETWORK_OR_DNS", "FAILURE_CLASS=SSH_AUTH_KEY_REJECTED"),
    GOOD.replace("KMJ_OFFSITE_EXIT3=READ_ONLY_CLASSIFIED", "KMJ_OFFSITE_EXIT3=BLOCKED"),
    GOOD + "X".repeat(3000),
    GOOD.replace("OFFHOST_BACKUP_VERIFIED=NO\n", ""),
    GOOD.replace("FAILURE_CLASS=REMOTE_NETWORK_OR_DNS",
                 "FAILURE_CLASS=REMOTE_NETWORK_OR_DNS\nFAILURE_CLASS=REMOTE_NETWORK_OR_DNS"),
  ]) {
    assert.throws(() => parseExit3Diagnostic(unsafe), /SUPERVISOR_EXIT3_DIAGNOSTIC_UNSAFE_OUTPUT/);
  }
});
test("only pinned root-owned non-symlink file and ancestors are trusted", () => {
  const variants = [
    { fileValue: file({ uid: 1000 }) }, { fileValue: file({ nlink: 2 }) },
    { fileValue: file({ mode: 0o100777 }) }, { fileValue: file({ mode: 0o104500 }) },
    { fileValue: file({ size: 0 }) }, { fileValue: file({ size: 50000 }) },
    { fileValue: file({ isSymbolicLink: () => true }) },
    { fileValue: file({ isFile: () => false }) },
    { dirValue: dir({ uid: 1000 }) }, { dirValue: dir({ mode: 0o40775 }) },
    { dirValue: dir({ isSymbolicLink: () => true }) },
    { source: "import subprocess; print('secret')" },
  ];
  for (const variant of variants) {
    const h = harness(variant);
    assert.throws(h.run, /SUPERVISOR_EXIT3_DIAGNOSTIC_NOT_READY/);
    assert.equal(h.executions.length, 0);
  }
});
test("executes only fixed python -I -B script --inspect, without shell/argv/env", () => {
  const h = harness();
  assert.equal(h.run().failureClass, "REMOTE_NETWORK_OR_DNS");
  assert.deepEqual(h.executions, [[
    "/usr/bin/python3", ["-I", "-B", EXIT3_DIAGNOSTIC_PATH, "--inspect"],
    { timeout: 25000, maxBuffer: 4096, cwd: "/" },
  ]]);
});
test("a swapped source after execution fails SHA pre/post attestation", () => {
  const h = harness({ after: "MALICIOUS" });
  assert.throws(h.run, /SUPERVISOR_EXIT3_DIAGNOSTIC_NOT_READY/);
  assert.equal(h.executions.length, 1);
});
test("child failure suppresses raw stderr and does not assert restore", () => {
  const h = harness({ failure: true });
  assert.throws(h.run, (err) => {
    assert.equal(err.code, "SUPERVISOR_EXIT3_DIAGNOSTIC_FAILED");
    assert.doesNotMatch(String(err.message), /root|ssh|secret|key/i);
    return true;
  });
});

test("supervisor handler refuses caller parameters and requires pinned exact confirmation", async () => {
  const calls = [];
  const handle = createSupervisorHandler({
    run: (...args) => { calls.push(args); return GOOD; },
    lstat: (p) => p === EXIT3_DIAGNOSTIC_PATH ? file() : dir(),
    readFile: () => SCRIPT,
  });
  for (const req of [
    { op: "main_platform_offsite_exit3_diagnostic" },
    { op: "main_platform_offsite_exit3_diagnostic", confirmation: "yes" },
    { op: "main_platform_offsite_exit3_diagnostic", confirmation: EXIT3_DIAGNOSTIC_CONFIRMATION, unit: "ssh.service" },
    { op: "main_platform_offsite_exit3_diagnostic", confirmation: EXIT3_DIAGNOSTIC_CONFIRMATION, argv: ["-c", "print(1)"] },
    { op: "main_platform_offsite_exit3_diagnostic", confirmation: EXIT3_DIAGNOSTIC_CONFIRMATION, env: { PATH: "/tmp" } },
  ]) await assert.rejects(handle(req), /INVALID_SUPERVISOR_REQUEST/);
  assert.equal(calls.length, 0);
  const { response } = await handle({
    op: "main_platform_offsite_exit3_diagnostic",
    confirmation: EXIT3_DIAGNOSTIC_CONFIRMATION,
  });
  assert.equal(response.mode, "READ_ONLY_FIXED_EXIT3_DIAGNOSTIC");
  assert.equal(response.scope, "kmj-main-platform");
  assert.equal(response.diagnostic.failureClass, "REMOTE_NETWORK_OR_DNS");
  assert.equal(response.diagnostic.execMainStatus, "3");
  assert.equal(response.mutations, "NONE");
  assert.equal(response.rawJournalExposed, false);
  assert.equal(response.recentBackupVerified, false);
  assert.equal(response.restoreVerified, false);
  assert.equal(response.productionReleaseApprovedByThisCheck, false);
  assert.equal(calls.length, 1);
});
test("supervisor exit3 gate refuses absent or modified operator-installed script", async () => {
  for (const variant of [
    { lstat: () => { throw Error("ENOENT"); }, readFile: () => SCRIPT },
    { lstat: (p) => p === EXIT3_DIAGNOSTIC_PATH ? file({uid:1001}) : dir(), readFile: () => SCRIPT },
    { lstat: (p) => p === EXIT3_DIAGNOSTIC_PATH ? file() : dir(), readFile: () => "UNPINNED" },
  ]) {
    let executed = false;
    const handle = createSupervisorHandler({
      ...variant,
      run: () => { executed = true; return GOOD; },
    });
    await assert.rejects(handle({
      op: "main_platform_offsite_exit3_diagnostic",
      confirmation: EXIT3_DIAGNOSTIC_CONFIRMATION,
    }), /SUPERVISOR_EXIT3_DIAGNOSTIC_NOT_READY/);
    assert.equal(executed, false);
  }
});
