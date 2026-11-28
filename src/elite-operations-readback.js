// Read-only status interpretation; neither a grant nor a deploy gate.
// Call only with observations collected by the authorized host backend.
// A green individual adapter never proves the complete release workflow.
const SHA = /^[a-f0-9]{40}$/;
const DAY_MS = 86_400_000;

export function summarizeEliteReadback({
  candidateSha,
  staging,
  production,
  maintenance,
} = {}) {
  const blockers = [];
  if (typeof candidateSha !== "string" || !SHA.test(candidateSha))
    blockers.push("CANDIDATE_UNKNOWN");
  if (
    staging?.approvedSha !== candidateSha ||
    staging?.currentSha !== candidateSha
  )
    blockers.push("STAGING_CANDIDATE_UNVERIFIED");
  if (staging?.productionUnchanged !== true)
    blockers.push("STAGING_PRODUCTION_CONTINUITY_UNVERIFIED");
  if (production?.approvedSha !== candidateSha)
    blockers.push("PRODUCTION_APPROVAL_SHA_MISMATCH");
  if (production?.nginxActive !== true || production?.phpFpmActive !== true)
    blockers.push("PRODUCTION_HEALTH_UNVERIFIED");
  if (production?.readyToActivate !== true)
    blockers.push("PRODUCTION_ADAPTER_NOT_READY");
  if (maintenance?.recentBackupVerified !== true)
    blockers.push("BACKUP_UNVERIFIED");
  if (maintenance?.restoreVerified !== true)
    blockers.push("RESTORE_UNVERIFIED");
  return {
    status: blockers.length ? "BLOCKED_OR_UNKNOWN" : "HOST_REVIEW_REQUIRED",
    blockers,
    authenticatedQaVerified: false,
    executionAuthorized: false,
    deploymentVerified: false,
  };
}

// Accept only nonsecret metadata from the existing owner policy verifier.
// Do not read or modify keys or policy here. The latest sequence must come
// from independently verified signed history, not a client-supplied counter.
export function signingPolicyHealth({
  verified,
  maxSequence,
  latestSequence,
  expiresAt,
  now,
} = {}) {
  const unknown = {
    status: "POLICY_UNKNOWN",
    remaining: null,
    ownerRenewalRequired: true,
    signingAuthorized: false,
  };
  if (
    verified !== true ||
    !Number.isSafeInteger(maxSequence) ||
    maxSequence < 30 ||
    maxSequence > 100_000 ||
    !Number.isSafeInteger(latestSequence) ||
    latestSequence < 1 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0
  )
    return unknown;
  const remaining = Math.max(0, maxSequence - latestSequence);
  const expired = expiresAt <= now;
  const exhausted = remaining === 0;
  const renewalSoon = remaining <= 5 || expiresAt - now <= 7 * DAY_MS;
  return {
    status: expired
      ? "POLICY_EXPIRED"
      : exhausted
        ? "SEQUENCE_POLICY_EXHAUSTED"
        : renewalSoon
          ? "RENEWAL_RECOMMENDED"
          : "HEADROOM_AVAILABLE",
    remaining,
    ownerRenewalRequired: expired || exhausted,
    renewalRecommended: renewalSoon || expired || exhausted,
    signingAuthorized: false,
  };
}
