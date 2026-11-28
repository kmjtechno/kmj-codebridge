// Local trusted updater orchestration only. The adapter owns the Windows ACL,
// exclusive lock, durable journal, fixed process identity and verified archive.
// Never construct it from a gateway request or a caller-selected command.
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function requireEvidence(ok, code) {
  if (ok !== true) throw new Error(code);
}

function releaseMatches(receipt, release) {
  return (
    receipt?.revision === release.revision &&
    receipt?.sequence === release.sequence
  );
}

function healthy(receipt, release, scope) {
  return (
    releaseMatches(receipt, release) &&
    receipt.authenticated === true &&
    receipt.processIdentityVerified === true &&
    receipt.catalogVerified === true &&
    receipt.device === scope.device &&
    receipt.project === scope.project
  );
}

export async function runWindowsUpdateTransaction(adapter) {
  return adapter.withExclusiveLock(async () => {
    const baseline = await adapter.readProtectedBaseline();
    requireEvidence(
      baseline?.protected === true &&
        baseline.pending === false &&
        Number.isSafeInteger(baseline.sequence) &&
        baseline.sequence > 0 &&
        baseline.highestAcceptedSequence === baseline.sequence &&
        typeof baseline.revision === "string" &&
        SHA.test(baseline.revision) &&
        typeof baseline.device === "string" &&
        baseline.device.length > 0 &&
        typeof baseline.project === "string" &&
        baseline.project.length > 0,
      "WINDOWS_UPDATE_BASELINE_UNVERIFIED",
    );
    const before = await adapter.readHealth();
    requireEvidence(
      healthy(before, baseline, baseline),
      "WINDOWS_UPDATE_BASELINE_HEALTH_UNVERIFIED",
    );
    const plan = await adapter.inspectSignedFeed(baseline);
    if (
      plan?.state === "CURRENT_ACCEPTED_REVISION" &&
      releaseMatches(plan, baseline)
    ) {
      return {
        state: "CURRENT_HEALTH_VERIFIED",
        sequence: baseline.sequence,
        revision: baseline.revision,
      };
    }
    requireEvidence(
      plan?.state === "NEW_SIGNED_RELEASE_CANDIDATE" &&
        plan.runningRevision === baseline.revision &&
        typeof plan.revision === "string" &&
        SHA.test(plan.revision) &&
        plan.revision !== baseline.revision &&
        Number.isSafeInteger(plan.sequence) &&
        plan.sequence > baseline.sequence &&
        typeof plan.archiveSha256 === "string" &&
        DIGEST.test(plan.archiveSha256) &&
        Number.isSafeInteger(plan.archiveBytes) &&
        plan.archiveBytes > 0,
      "WINDOWS_UPDATE_CANDIDATE_UNVERIFIED",
    );
    const stage = await adapter.prepareVerifiedCandidate(plan);
    requireEvidence(
      releaseMatches(stage, plan) &&
        stage.archiveSha256 === plan.archiveSha256 &&
        stage.archiveBytes === plan.archiveBytes &&
        stage.archiveVerified === true &&
        stage.runtimePreflightVerified === true &&
        stage.protectedStageVerified === true,
      "WINDOWS_UPDATE_STAGE_UNVERIFIED",
    );
    // Drain and hold the execution gate before reserving the watermark.
    const drained = await adapter.drainJobs();
    requireEvidence(
      drained?.admissionClosed === true && drained.activeJobs === 0,
      "WINDOWS_UPDATE_JOBS_NOT_DRAINED",
    );
    // An ambiguous reservation/commit must leave the gate closed. Never retry
    // a sequence automatically after activation has been attempted.
    const reserved = await adapter.reserveSequence(baseline, plan);
    requireEvidence(
      releaseMatches(reserved, plan) && reserved.durable === true,
      "WINDOWS_UPDATE_RESERVATION_UNVERIFIED",
    );
    let result;
    try {
      await adapter.activatePreparedCandidate(plan);
      const after = await adapter.readHealth();
      requireEvidence(
        healthy(after, plan, baseline),
        "WINDOWS_UPDATE_CANDIDATE_HEALTH_UNVERIFIED",
      );
      result = { state: "ACTIVATED", active: plan };
    } catch {
      try {
        await adapter.restoreKnownGood(baseline);
        const restored = await adapter.readHealth();
        requireEvidence(
          healthy(restored, baseline, baseline),
          "WINDOWS_UPDATE_ROLLBACK_HEALTH_UNVERIFIED",
        );
        result = { state: "ROLLED_BACK", active: baseline };
      } catch {
        // Reservation remains durable and execution remains closed. The local
        // recovery procedure must reconcile this pending transaction.
        throw new Error("WINDOWS_UPDATE_RECOVERY_REQUIRED");
      }
    }
    const recorded = await adapter.recordOutcome(plan, result);
    requireEvidence(
      releaseMatches(recorded, result.active) &&
        recorded.durable === true &&
        recorded.highestAcceptedSequence === plan.sequence &&
        recorded.state === result.state,
      "WINDOWS_UPDATE_OUTCOME_UNVERIFIED",
    );
    const resumed = await adapter.resumeJobs();
    requireEvidence(
      resumed?.admissionOpen === true,
      "WINDOWS_UPDATE_JOB_RESUME_UNVERIFIED",
    );
    return {
      state: result.state,
      sequence: result.active.sequence,
      revision: result.active.revision,
      highestAcceptedSequence: plan.sequence,
      healthyActivationVerified: result.state === "ACTIVATED",
      rollbackHealthVerified: result.state === "ROLLED_BACK",
    };
  });
}
