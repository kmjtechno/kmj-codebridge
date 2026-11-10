import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";
import { OFFSITE_DIAGNOSTIC_CONFIRMATION } from "../src/offsite-diagnostic-policy.js";

const DEVICE = "kmj-elite-main-platform";
const PROJECT = "kmj-main-platform";

function fixture(t, {
  device = DEVICE,
  project = PROJECT,
  writable = true,
  supervisor = true,
  payload = null,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-offsite-classify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  const calls = [];
  const starts = [];
  const mockSupervisor = supervisor
    ? {
        request: async (request) => {
          calls.push(request);
          return {
            response: payload ?? {
              mode: "READ_ONLY_FIXED_DIAGNOSTIC",
              scope: PROJECT,
              unit: "kmj-elite-offsite-backup.service",
              diagnostic: {
                failure_class: "SSH_AUTH_KEY_REJECTED",
                journal_scope: "EXACT_INVOCATION",
                exec_main_status: "255",
                result: "exit-code",
                secretToken: "must-never-be-returned",
              },
              mutations: "NONE",
              rawJournalExposed: false,
              recentBackupVerified: false,
              restoreVerified: false,
              productionReleaseApprovedByThisCheck: false,
              secretToken: "must-never-be-returned",
            },
          };
        },
      }
    : null;
  const runner = {
    maxConcurrent: 1,
    run: (options) => {
      starts.push(options);
      throw Error("No project job or shell may be scheduled");
    },
  };
  const dispatch = createDispatcher(
    {
      id: device,
      stateDir,
      projects: [{ id: project, root, writable, gates: {}, commands: {} }],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
    null,
    mockSupervisor,
  );
  const input = (changes = {}) => ({
    device,
    project,
    command: "main_platform_offsite_diagnostic",
    variant: OFFSITE_DIAGNOSTIC_CONFIRMATION,
    requestKey: "offsite-legacy-classify-20261110",
    ...changes,
  });
  return { dispatch, input, calls, starts };
}

test("legacy-client profile requires explicit fixed confirmation and is read-only", async (t) => {
  const f = fixture(t);
  const all = await f.dispatch("list_project_commands", {
    device: DEVICE,
    project: PROJECT,
  }, ["read"]);
  const profile = all.commands.find((p) => p.id === "main_platform_offsite_diagnostic");
  assert.ok(profile);
  assert.equal(profile.approvalRequired, true);
  assert.deepEqual(profile.variants, [OFFSITE_DIAGNOSTIC_CONFIRMATION]);
  assert.equal(profile.category, "inspect");

  const result = await f.dispatch("run_project_command", f.input(), ["execute"]);
  assert.deepEqual(f.calls, [{
    op: "main_platform_offsite_diagnostic",
    confirmation: OFFSITE_DIAGNOSTIC_CONFIRMATION,
  }]);
  assert.deepEqual(f.starts, []);
  assert.equal(result.failureClass, "SSH_AUTH_KEY_REJECTED");
  assert.equal(result.journalScope, "EXACT_INVOCATION");
  assert.equal(result.exit255Observed, true);
  assert.equal(result.rawJournalExposed, false);
  assert.equal(result.candidateEncryptedOffsiteVerified, false);
  assert.equal(result.independentRestoreVerified, false);
  assert.equal(result.rollbackVerified, false);
  assert.equal(result.productionApprovalChanged, false);
  assert.doesNotMatch(
    JSON.stringify(result),
    /must-never-be-returned|secretToken|\/root\/|privateKey|PASSWORD|rawJournal/i,
  );
});

test("compat diagnosis cannot be invoked with non-exact variants or lane overrides", async (t) => {
  const f = fixture(t);
  for (const change of [
    { variant: "overview" },
    { variant: "classify" },
    { variant: "RUN_FIXED_READONLY_OFFSITE_DIAGNOSTIC " },
    { variant: "upload" },
    { laneId: "my-lane" },
    { expectedHead: "a".repeat(40) },
    { command: "main_platform_offsite_status" , variant: "RUN_FIXED_READONLY_OFFSITE_DIAGNOSTIC" },
  ]) {
    if (change.command === "main_platform_offsite_status") continue;
    await assert.rejects(f.dispatch("run_project_command", f.input(change), ["execute"]));
  }
  await assert.rejects(
    f.dispatch("run_project_command", f.input(), ["read"]),
    /ACCESS_DENIED/,
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.starts, []);
});

test("wrong host, project or missing supervisor cannot classify as approved", async (t) => {
  for (const options of [
    { device: "google-vps" },
    { project: "kmj-cloudos" },
    { writable: false },
    { supervisor: false },
  ]) {
    const f = fixture(t, options);
    const all = await f.dispatch("list_project_commands", {
      device: options.device ?? DEVICE,
      project: options.project ?? PROJECT,
    }, ["read"]);
    assert.equal(
      all.commands.some((c) => c.id === "main_platform_offsite_diagnostic"),
      false,
    );
    await assert.rejects(
      f.dispatch("run_project_command", f.input(), ["execute"]),
      /MAIN_PLATFORM_OFFSITE_DIAGNOSTIC_NOT_AUTHORIZED|SUPERVISOR_UNAVAILABLE/,
    );
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.starts, []);
  }
});

test("supervisor unverified metadata and arbitrary classes fail closed", async (t) => {
  const valid = {
    mode: "READ_ONLY_FIXED_DIAGNOSTIC",
    scope: PROJECT,
    unit: "kmj-elite-offsite-backup.service",
    diagnostic: {
      failure_class: "NETWORK_OR_REMOTE_DOWN",
      journal_scope: "EXACT_INVOCATION",
      exec_main_status: "255",
      result: "exit-code",
    },
    mutations: "NONE",
    rawJournalExposed: false,
    recentBackupVerified: false,
    restoreVerified: false,
    productionReleaseApprovedByThisCheck: false,
  };
  const invalid = [
    { mutations: "STARTED_SERVICE" },
    { mode: "MUTATING" },
    { rawJournalExposed: true },
    { recentBackupVerified: true },
    { restoreVerified: true },
    { productionReleaseApprovedByThisCheck: true },
    { unit: "ssh.service" },
    { scope: "other-project" },
    { diagnostic: { ...valid.diagnostic, failure_class: "token=SECRET" } },
    { diagnostic: { ...valid.diagnostic, journal_scope: "/root/private" } },
    { diagnostic: { ...valid.diagnostic, exec_main_status: "256" } },
    { diagnostic: { ...valid.diagnostic, result: "unknown" } },
    { diagnostic: { ...valid.diagnostic, failure_class: "SSH_AUTH_KEY_REJECTED", journal_scope: "UNAVAILABLE" } },
  ];
  for (const change of invalid) {
    const f = fixture(t, { payload: { ...valid, ...change } });
    await assert.rejects(
      f.dispatch("run_project_command", f.input(), ["execute"]),
      /MAIN_PLATFORM_OFFSITE_DIAGNOSTIC_UNVERIFIED/,
    );
    assert.deepEqual(f.starts, []);
  }
});

test("unknown failure is never credited as remote backup, restore or release", async (t) => {
  const f = fixture(t, { payload: {
    mode: "READ_ONLY_FIXED_DIAGNOSTIC",
    scope: PROJECT,
    unit: "kmj-elite-offsite-backup.service",
    diagnostic: {
      failure_class: "UNKNOWN_EXIT_255_NEEDS_LOG",
      journal_scope: "UNAVAILABLE",
      exec_main_status: "255",
      result: "exit-code",
    },
    mutations: "NONE",
    rawJournalExposed: false,
    recentBackupVerified: false,
    restoreVerified: false,
    productionReleaseApprovedByThisCheck: false,
  }});
  const out = await f.dispatch("run_project_command", f.input(), ["execute"]);
  assert.equal(out.failureClass, "UNKNOWN_EXIT_255_NEEDS_LOG");
  assert.equal(out.exit255Observed, true);
  assert.equal(out.candidateEncryptedOffsiteVerified, false);
  assert.equal(out.independentRestoreVerified, false);
  assert.equal(out.productionApprovalChanged, false);
});
