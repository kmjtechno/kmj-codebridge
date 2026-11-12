import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";

const DEVICE = "kmj-elite-main-platform";
const PROJECT = "kmj-main-platform";

function receipt(overrides = {}) {
  return {
    mode: "READ_ONLY",
    scope: PROJECT,
    services: {
      offsiteBackup: {
        installed: true, activeState: "failed", result: "exit-code",
        execMainStatus: "3",
      },
      offsiteBackupTimer: { installed: true, activeState: "active", result: "success" },
      healthCheck: { installed: true, activeState: "inactive", result: "success", execMainStatus: "0" },
    },
    offsitePrefixFailure: {
      line: "LINE_24",
      journalScope: "EXACT_INVOCATION",
      rawJournalExposed: false, backupVerified: false,
      restoreVerified: false, secretValue: "must-not-forward",
    },
    recentBackupVerified: false,
    restoreVerified: false,
    productionReleaseApprovedByThisCheck: false,
    ...overrides,
  };
}
async function invoke(t, payload) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-v32-compat-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "src");
  fs.mkdirSync(root);
  const calls = [];
  const dispatch = createDispatcher(
    { id: DEVICE, stateDir: temp,
      projects: [{ id: PROJECT, root, writable: true, gates: {}, commands: {} }] },
    { maxConcurrent: 1, run: () => assert.fail("read-only status must not schedule a job") },
    () => ({ features: ["read", "write", "execute"], limits: { concurrent_jobs: 1 } }),
    null,
    { request: async (req) => { calls.push(req); return { response: payload }; } },
  );
  const result = await dispatch(
    "run_project_command",
    { device: DEVICE, project: PROJECT, command: "main_platform_offsite_status",
      variant: "overview", requestKey: "kmj-v32-fixed-compat-20261112" },
    ["execute"],
  );
  assert.deepEqual(calls, [{ op: "main_platform_maintenance_status" }]);
  return result;
}

test("existing client receives only a redacted, categorical advisory line", async (t) => {
  const value = await invoke(t, receipt());
  assert.equal(value.backupPrefixFailureLine, "LINE_24");
  assert.equal(value.backupPrefixJournalScope, "EXACT_INVOCATION");
  assert.equal(value.rawJournalExposed, false);
  assert.equal(value.independentRestoreVerified, false);
  assert.equal(value.candidateEncryptedOffsiteVerified, false);
  assert.equal(value.productionApprovalChanged, false);
  assert.doesNotMatch(JSON.stringify(value), /must-not-forward|secretValue|InvocationID|journalctl/);
});

test("spoofed or unverified supervisor telemetry always degrades to UNKNOWN", async (t) => {
  for (const bad of [
    { offsitePrefixFailure: { ...receipt().offsitePrefixFailure, line: "LINE_29" } },
    { offsitePrefixFailure: { ...receipt().offsitePrefixFailure, journalScope: "UNAVAILABLE" } },
    { offsitePrefixFailure: { ...receipt().offsitePrefixFailure, rawJournalExposed: true } },
    { offsitePrefixFailure: { ...receipt().offsitePrefixFailure, backupVerified: true } },
    { offsitePrefixFailure: { ...receipt().offsitePrefixFailure, restoreVerified: true } },
    { mode: "MUTATING" },
    { services: { ...receipt().services, offsiteBackup: { ...receipt().services.offsiteBackup, execMainStatus: "255" } } },
  ]) {
    const value = await invoke(t, receipt(bad));
    assert.equal(value.backupPrefixFailureLine, "UNKNOWN");
    assert.equal(value.backupPrefixJournalScope, "UNVERIFIED");
  }
});

test("old installed supervisors without new field remain compatible", async (t) => {
  const state = receipt();
  delete state.offsitePrefixFailure;
  const value = await invoke(t, state);
  assert.equal(value.backupService.result, "exit-code");
  assert.equal(value.backupPrefixFailureLine, "UNKNOWN");
});
