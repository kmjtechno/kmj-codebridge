import test from "node:test";
import assert from "node:assert/strict";
import { runWindowsUpdateTransaction } from "../src/windows-update-transaction.js";

const baseline = {
  protected: true,
  pending: false,
  device: "studio",
  project: "calibration",
  sequence: 42,
  highestAcceptedSequence: 42,
  revision: "a".repeat(40),
};
const plan = {
  state: "NEW_SIGNED_RELEASE_CANDIDATE",
  sequence: 43,
  revision: "b".repeat(40),
  runningRevision: baseline.revision,
  archiveSha256: "c".repeat(64),
  archiveBytes: 2048,
};

function fixture(overrides = {}) {
  const calls = [];
  let active = baseline;
  const adapter = {
    withExclusiveLock: async (run) => run(),
    readProtectedBaseline: async () => baseline,
    readHealth: async () => ({
      ...active,
      device: baseline.device,
      project: baseline.project,
      authenticated: true,
      processIdentityVerified: true,
      catalogVerified: true,
    }),
    inspectSignedFeed: async () => plan,
    prepareVerifiedCandidate: async () => ({
      ...plan,
      archiveVerified: true,
      runtimePreflightVerified: true,
      protectedStageVerified: true,
    }),
    drainJobs: async () => ({ admissionClosed: true, activeJobs: 0 }),
    reserveSequence: async () => ({ ...plan, durable: true }),
    activatePreparedCandidate: async () => {
      active = plan;
    },
    restoreKnownGood: async () => {
      active = baseline;
    },
    recordOutcome: async (candidate, outcome) => ({
      ...outcome.active,
      state: outcome.state,
      durable: true,
      highestAcceptedSequence: candidate.sequence,
    }),
    resumeJobs: async () => ({ admissionOpen: true }),
    ...overrides,
  };
  for (const key of Object.keys(adapter)) {
    const fn = adapter[key];
    adapter[key] = async (...args) => {
      calls.push(key);
      return fn(...args);
    };
  }
  return { adapter, calls };
}

test("activation requires drain, durable reservation and exact health", async () => {
  const { adapter, calls } = fixture();
  const result = await runWindowsUpdateTransaction(adapter);
  assert.equal(result.state, "ACTIVATED");
  assert.equal(result.healthyActivationVerified, true);
  assert.deepEqual(calls, [
    "withExclusiveLock",
    "readProtectedBaseline",
    "readHealth",
    "inspectSignedFeed",
    "prepareVerifiedCandidate",
    "drainJobs",
    "reserveSequence",
    "activatePreparedCandidate",
    "readHealth",
    "recordOutcome",
    "resumeJobs",
  ]);
});

test("running jobs prevent reservation and activation", async () => {
  const { adapter, calls } = fixture({
    drainJobs: async () => ({ admissionClosed: true, activeJobs: 1 }),
  });
  await assert.rejects(
    runWindowsUpdateTransaction(adapter),
    /WINDOWS_UPDATE_JOBS_NOT_DRAINED/,
  );
  assert.equal(calls.includes("reserveSequence"), false);
});

test("unverified durable reservation cannot trigger activation", async () => {
  const { adapter, calls } = fixture({
    reserveSequence: async () => ({ ...plan, durable: false }),
  });
  await assert.rejects(
    runWindowsUpdateTransaction(adapter),
    /WINDOWS_UPDATE_RESERVATION_UNVERIFIED/,
  );
  assert.equal(calls.includes("activatePreparedCandidate"), false);
  assert.equal(calls.includes("resumeJobs"), false);
});

test("failed activation rolls back but preserves sequence watermark", async () => {
  const { adapter, calls } = fixture({
    activatePreparedCandidate: async () => {
      throw new Error("fixture failure");
    },
  });
  const result = await runWindowsUpdateTransaction(adapter);
  assert.equal(result.state, "ROLLED_BACK");
  assert.equal(result.rollbackHealthVerified, true);
  assert.equal(result.highestAcceptedSequence, 43);
  assert.equal(result.revision, baseline.revision);
  assert.equal(calls.includes("resumeJobs"), true);
});

test("rollback failure retains reservation and closed execution gate", async () => {
  const { adapter, calls } = fixture({
    activatePreparedCandidate: async () => {},
    restoreKnownGood: async () => {
      throw new Error("fixture failure");
    },
  });
  await assert.rejects(
    runWindowsUpdateTransaction(adapter),
    /WINDOWS_UPDATE_RECOVERY_REQUIRED/,
  );
  assert.equal(calls.includes("recordOutcome"), false);
  assert.equal(calls.includes("resumeJobs"), false);
});

test("ambiguous final write never resumes jobs or retries activation", async () => {
  const { adapter, calls } = fixture({
    recordOutcome: async () => ({ durable: false }),
  });
  await assert.rejects(
    runWindowsUpdateTransaction(adapter),
    /WINDOWS_UPDATE_OUTCOME_UNVERIFIED/,
  );
  assert.equal(calls.includes("resumeJobs"), false);
  assert.equal(calls.includes("restoreKnownGood"), false);
});

test("a pending baseline cannot be overwritten by a new update", async () => {
  const { adapter, calls } = fixture({
    readProtectedBaseline: async () => ({ ...baseline, pending: true }),
  });
  await assert.rejects(
    runWindowsUpdateTransaction(adapter),
    /WINDOWS_UPDATE_BASELINE_UNVERIFIED/,
  );
  assert.equal(calls.includes("inspectSignedFeed"), false);
});

test("a rolled-back baseline cannot replay the reserved sequence", async () => {
  const { adapter, calls } = fixture({
    readProtectedBaseline: async () => ({
      ...baseline,
      highestAcceptedSequence: 43,
    }),
  });
  await assert.rejects(
    runWindowsUpdateTransaction(adapter),
    /WINDOWS_UPDATE_BASELINE_UNVERIFIED/,
  );
  assert.equal(calls.includes("inspectSignedFeed"), false);
});
