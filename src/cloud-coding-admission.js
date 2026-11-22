// Pure, fail-closed admission preflight. This module never calls an inference provider,
// reads credentials, transfers source, creates a worktree, or starts a worker.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sha = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const nonempty = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function evaluateCloudCodingAdmission(input) {
  const deny = (reason) => ({ allowed: false, reason });
  if (!input || typeof input !== "object" || Array.isArray(input))
    return deny("INVALID_INPUT");
  const { provider, consent, lane, qa, release } = input;
  if (!provider || typeof provider !== "object")
    return deny("PROVIDER_EVIDENCE_MISSING");
  if (
    provider.upstreamProviderVerified !== true ||
    provider.billingVerified !== true
  )
    return deny("PROVIDER_ACCOUNT_UNVERIFIED");
  if (
    provider.zeroPriceVerified !== true ||
    provider.quotaVerified !== true ||
    provider.noPaidFallbackVerified !== true ||
    provider.paidInference !== false
  )
    return deny("ZERO_CHARGE_NOT_ATTESTED");
  if (
    !nonempty(provider.accountId) ||
    !nonempty(provider.routeId) ||
    !nonempty(provider.snapshotId) ||
    !nonempty(provider.attestationId) ||
    provider.snapshotFresh !== true ||
    provider.routeBound !== true
  )
    return deny("PROVIDER_ROUTE_SNAPSHOT_UNTRUSTED");
  if (!consent || typeof consent !== "object")
    return deny("SOURCE_TRANSFER_CONSENT_MISSING");
  if (
    consent.approved !== true ||
    !nonempty(consent.project) ||
    !nonempty(consent.accountId) ||
    !nonempty(consent.routeId) ||
    consent.accountId !== provider.accountId ||
    consent.routeId !== provider.routeId ||
    !nonempty(consent.approvalId)
  )
    return deny("SOURCE_TRANSFER_CONSENT_INVALID");
  if (
    !lane ||
    typeof lane !== "object" ||
    lane.project !== consent.project ||
    !sha(lane.head) ||
    lane.dirty !== false ||
    lane.isolated !== true ||
    lane.currentHeadVerified !== true ||
    lane.mayPrepare !== true
  )
    return deny("ISOLATED_SHA_PINNED_LANE_UNVERIFIED");
  if (
    !qa ||
    typeof qa !== "object" ||
    qa.approved !== true ||
    qa.nonDestructive !== true ||
    !nonempty(qa.recipeId)
  )
    return deny("QA_RECIPE_UNAPPROVED");
  if (
    !release ||
    typeof release !== "object" ||
    release.ownerSigned !== true ||
    release.immutableVerified !== true ||
    release.supervisorBound !== true ||
    !sha(release.revision)
  )
    return deny("SIGNED_ACTIVATION_UNVERIFIED");
  if (
    !own(input, "explicitActivationRequested") ||
    input.explicitActivationRequested !== true
  )
    return deny("ACTIVATION_NOT_REQUESTED");
  // An advisory decision only; runtime must revalidate trusted evidence atomically.
  return { allowed: true, reason: "PREFLIGHT_ONLY_REVALIDATE_AT_EXECUTION" };
}
