import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createSupervisorHandler } from "../src/supervisor.js";
import {
  OFFSITE_DIAGNOSTIC_PATH,
  OFFSITE_DIAGNOSTIC_SHA256,
  parseOffsiteDiagnostic,
} from "../src/offsite-diagnostic-policy.js";

// Byte-identical copy of kmj-main-platform scripts/operations/diagnose-offsite-backup-unit-20261029.sh.
// Its digest must equal the Supervisor pin, so any drift in either place fails CI.
const PINNED_TEXT = fs.readFileSync(
  new URL(
    "./fixtures/diagnose-offsite-backup-unit-20261029.sh",
    import.meta.url,
  ),
  "utf8",
);
const CONFIRM = "RUN_FIXED_READONLY_OFFSITE_DIAGNOSTIC";
const GOOD_KEYS = {
  generated_utc: "2026-10-30T12:00:00Z",
  unit: "kmj-elite-offsite-backup.service",
  load_state: "loaded",
  active_state: "failed/failed",
  result: "exit-code",
  exec_main_status: "255",
  metadata_paths_exposed: "no",
  disk_root_free_kib: "1000000",
  disk_var_free_kib: "900000",
  disk_var_free_inodes: "50000",
  journal_scope: "EXACT_INVOCATION",
  journal_lines_scanned: "42",
  failure_class: "SSH_AUTH_KEY_REJECTED",
  raw_output_suppressed: "yes",
  recentBackupVerified_claim:
    "NO_THIS_SCRIPT_PROVES_NOTHING_ABOUT_BACKUP_VALIDITY",
  mutations: "NONE",
};
const out = (overrides = {}, drop = []) =>
  Object.entries({ ...GOOD_KEYS, ...overrides })
    .filter(([k]) => !drop.includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";

const rootFile = (over = {}) => ({
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  uid: 0,
  nlink: 1,
  mode: 0o100750,
  size: 4000,
  ...over,
});
const rootDir = (over = {}) => ({
  isFile: () => false,
  isDirectory: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  mode: 0o40755,
  ...over,
});

function harness({
  scriptText = PINNED_TEXT,
  file = rootFile(),
  dir = rootDir(),
  output = out(),
  runThrows = false,
  swapAfterRun = false,
} = {}) {
  const runs = [];
  const started = [];
  let reads = 0;
  const handle = createSupervisorHandler({
    run: (exe, args, options) => {
      runs.push({ exe, args, options });
      if (runThrows) throw Error("secret-stderr /root/.ssh/id");
      return output;
    },
    start: (u) => started.push(u),
    restart: (u) => started.push(u),
    lstat: (p) => {
      if (p === OFFSITE_DIAGNOSTIC_PATH) return file;
      if (p === "/usr/local/libexec") return dir;
      throw Error("ENOENT");
    },
    readFile: (p) => {
      assert.equal(p, OFFSITE_DIAGNOSTIC_PATH);
      reads += 1;
      return swapAfterRun && reads > 1 ? "SWAPPED" : scriptText;
    },
  });
  return { handle, runs, started };
}

test("pinned hash constant is the digest of the reviewed script fixture", () => {
  assert.match(OFFSITE_DIAGNOSTIC_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(
    createHash("sha256").update(PINNED_TEXT).digest("hex"),
    OFFSITE_DIAGNOSTIC_SHA256,
  );
  // The reviewed script is read-only: no writes, service control or arguments.
  const code = PINNED_TEXT.split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /systemctl\s+(start|stop|restart|enable|disable|kill|daemon)|\brm\s|\bcurl\b|\bwget\b|\bssh\s|\bsftp\s|\bsudo\b|>\s*\/(etc|var|root)/,
  );
  assert.equal(
    OFFSITE_DIAGNOSTIC_PATH,
    "/usr/local/libexec/kmj-main-platform-diagnose-offsite-backup-unit-20261029.sh",
  );
});

test("parser accepts exactly the categorical diagnostic and reports only safe fields", () => {
  const parsed = parseOffsiteDiagnostic(out());
  assert.deepEqual(Object.keys(parsed).sort(), [
    "active_state",
    "exec_main_status",
    "failure_class",
    "generated_utc",
    "journal_lines_scanned",
    "journal_scope",
    "load_state",
    "result",
  ]);
  assert.equal(parsed.failure_class, "SSH_AUTH_KEY_REJECTED");
  assert.equal(
    parseOffsiteDiagnostic(
      out({
        failure_class: "UNKNOWN_EXIT_255_NEEDS_LOG",
        journal_scope: "UNAVAILABLE",
        journal_lines_scanned: "0",
      }),
    ).failure_class,
    "UNKNOWN_EXIT_255_NEEDS_LOG",
  );
});

test("parser fails closed on extra keys, duplicates, missing keys and raw leaks", () => {
  const bad = [
    out() + "extra=1\n",
    out() + "failure_class=SSH_HOSTKEY\n",
    out({}, ["mutations"]),
    out({}, ["failure_class"]),
    out({ mutations: "SOME" }),
    out({ raw_output_suppressed: "no" }),
    out({ metadata_paths_exposed: "yes" }),
    out({ unit: "ssh.service" }),
    out({ failure_class: "BECAUSE_SSH_SAID_PERMISSION_DENIED_PUBLICKEY" }),
    out({ result: "exit-code /root/.ssh/id_ed25519" }),
    out({ active_state: "failed/failed\nPermission denied (publickey)" }),
    out({ journal_lines_scanned: "42 lines" }),
    out({ generated_utc: "yesterday" }),
    out({ recentBackupVerified_claim: "YES" }),
    "Permission denied (publickey).\n" + out(),
    out() + ["-----BEGIN ", "OPENSSH", " PRIVATE ", "KEY-----\n"].join(""),
    "garbage\n",
    "",
    "x".repeat(5000),
  ];
  for (const text of bad)
    assert.throws(
      () => parseOffsiteDiagnostic(text),
      /SUPERVISOR_OFFSITE_DIAGNOSTIC_UNSAFE_OUTPUT/,
      JSON.stringify(text.slice(0, 40)),
    );
});

test("a classified cause is only accepted for an exact exit-255 invocation", () => {
  for (const overrides of [
    { journal_scope: "UNAVAILABLE" },
    { exec_main_status: "1" },
    { exec_main_status: "unknown" },
    { result: "success" },
  ])
    assert.throws(
      () => parseOffsiteDiagnostic(out(overrides)),
      /SUPERVISOR_OFFSITE_DIAGNOSTIC_INCONSISTENT/,
    );
  // Stale / missing InvocationID => the script reports UNAVAILABLE + UNKNOWN: accepted, no cause claimed.
  const unknown = parseOffsiteDiagnostic(
    out({
      journal_scope: "UNAVAILABLE",
      failure_class: "UNKNOWN_EXIT_255_NEEDS_LOG",
      journal_lines_scanned: "0",
    }),
  );
  assert.equal(unknown.failure_class, "UNKNOWN_EXIT_255_NEEDS_LOG");
});

test("op takes only the fixed confirmation: no caller args, paths, env or shell", async () => {
  const h = harness();
  for (const injection of [
    {},
    { confirmation: "yes" },
    { confirmation: CONFIRM, path: "/root/.ssh" },
    { confirmation: CONFIRM, args: ["--all"] },
    { confirmation: CONFIRM, unit: "nginx.service" },
    { confirmation: CONFIRM, command: "/bin/sh" },
    { confirmation: CONFIRM, env: { X: "1" } },
    { confirmation: CONFIRM, script: "/tmp/x" },
  ])
    await assert.rejects(
      h.handle({ op: "main_platform_offsite_diagnostic", ...injection }),
    );
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.started, []);
});

test("script not installed / wrong owner / symlink / writable / setuid / hardlinked / oversize is refused before running", async () => {
  const variants = [
    { file: rootFile({ uid: 1000 }) },
    { file: rootFile({ isSymbolicLink: () => true }) },
    { file: rootFile({ isFile: () => false }) },
    { file: rootFile({ mode: 0o100770 }) },
    { file: rootFile({ mode: 0o100757 }) },
    { file: rootFile({ mode: 0o104750 }) },
    { file: rootFile({ mode: 0o100640 }) },
    { file: rootFile({ nlink: 2 }) },
    { file: rootFile({ size: 0 }) },
    { file: rootFile({ size: 1 << 20 }) },
    { dir: rootDir({ uid: 1000 }) },
    { dir: rootDir({ mode: 0o40777 }) },
    { dir: rootDir({ isSymbolicLink: () => true }) },
  ];
  for (const variant of variants) {
    const h = harness(variant);
    await assert.rejects(
      h.handle({
        op: "main_platform_offsite_diagnostic",
        confirmation: CONFIRM,
      }),
      /SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY/,
    );
    assert.deepEqual(h.runs, []);
  }
  const missing = createSupervisorHandler({
    run: () => assert.fail("must not run"),
    lstat: () => {
      throw Error("ENOENT");
    },
    readFile: () => {
      throw Error("ENOENT");
    },
  });
  await assert.rejects(
    missing({ op: "main_platform_offsite_diagnostic", confirmation: CONFIRM }),
    /SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY/,
  );
});

test("a swapped or modified script (hash mismatch) is never executed", async () => {
  const h = harness({ scriptText: "#!/bin/sh\ncat /root/.ssh/id_ed25519\n" });
  await assert.rejects(
    h.handle({ op: "main_platform_offsite_diagnostic", confirmation: CONFIRM }),
    /SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY/,
  );
  assert.deepEqual(h.runs, []);
});

test("child failure surfaces a fixed error and never its stderr or paths", async () => {
  const h = harness({ runThrows: true });
  await assert.rejects(
    h.handle({ op: "main_platform_offsite_diagnostic", confirmation: CONFIRM }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_OFFSITE_DIAGNOSTIC_FAILED");
      assert.doesNotMatch(String(error.message), /secret|\/root/);
      return true;
    },
  );
  assert.deepEqual(h.started, []);
});

test("valid run executes only the pinned path with no arguments and returns a categorical, non-approving result", async () => {
  const h = harness();
  const { response } = await h.handle({
    op: "main_platform_offsite_diagnostic",
    confirmation: CONFIRM,
  });
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].exe, OFFSITE_DIAGNOSTIC_PATH);
  assert.deepEqual(h.runs[0].args, []);
  assert.equal(h.runs[0].options.cwd, "/");
  assert.equal(response.mode, "READ_ONLY_FIXED_DIAGNOSTIC");
  assert.equal(response.diagnostic.failure_class, "SSH_AUTH_KEY_REJECTED");
  assert.equal(response.mutations, "NONE");
  assert.equal(response.rawJournalExposed, false);
  assert.equal(response.recentBackupVerified, false);
  assert.equal(response.restoreVerified, false);
  assert.equal(response.productionReleaseApprovedByThisCheck, false);
  assert.deepEqual(h.started, []);
  assert.doesNotMatch(
    JSON.stringify(response),
    /\/etc\/|\/root\/|\.env|privateKey|PASSWORD|token|publickey/i,
  );
});

test("script output that leaks journal text or claims a different state is rejected", async () => {
  for (const output of [
    out() + "Permission denied (publickey).\n",
    out({ mutations: "RESTARTED" }),
    out({ unit: "ssh.service" }),
    "BLOCKED=ROOT_REQUIRED_FOR_JOURNAL\n",
  ]) {
    const h = harness({ output });
    await assert.rejects(
      h.handle({
        op: "main_platform_offsite_diagnostic",
        confirmation: CONFIRM,
      }),
      /SUPERVISOR_OFFSITE_DIAGNOSTIC_(UNSAFE_OUTPUT|INCONSISTENT)/,
    );
  }
});

test("a script swapped between attestation and completion is not trusted", async () => {
  const h = harness({ swapAfterRun: true });
  await assert.rejects(
    h.handle({ op: "main_platform_offsite_diagnostic", confirmation: CONFIRM }),
    /SUPERVISOR_OFFSITE_DIAGNOSTIC_NOT_READY/,
  );
});
