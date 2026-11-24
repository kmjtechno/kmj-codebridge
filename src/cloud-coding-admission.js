// Pure, fail-closed admission preflight. This module never calls an inference provider,
// reads credentials, transfers source, creates a worktree, or starts a worker.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sha = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const nonempty = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

// Evidence input may come from a plugin, IPC or a developer fixture. Require
// plain, own data fields before inspecting values; inherited approvals and
// getters must never become owner authorization.
function ownDataRecord(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const snapshot = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !own(descriptor, "value")) return null;
    // Never read the original property: a Proxy get trap could return a
    // different value or execute code after the descriptor was validated.
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function assessCloudCodingAdmission(input) {
  const deny = (reason) => ({ allowed: false, reason });
  if (!input || typeof input !== "object" || Array.isArray(input))
    return deny("INVALID_INPUT");
  const root = ownDataRecord(input, [
    "provider",
    "consent",
    "lane",
    "qa",
    "release",
    "explicitActivationRequested",
  ]);
  if (!root) return deny("UNTRUSTED_EVIDENCE_FIELDS");
  const provider = ownDataRecord(root.provider, [
    "upstreamProviderVerified",
    "billingVerified",
    "zeroPriceVerified",
    "quotaVerified",
    "noPaidFallbackVerified",
    "paidInference",
    "accountId",
    "routeId",
    "snapshotId",
    "attestationId",
    "snapshotFresh",
    "routeBound",
  ]);
  const consent = ownDataRecord(root.consent, [
    "approved",
    "project",
    "accountId",
    "routeId",
    "approvalId",
  ]);
  const lane = ownDataRecord(root.lane, [
    "project",
    "head",
    "dirty",
    "isolated",
    "currentHeadVerified",
    "mayPrepare",
  ]);
  const qa = ownDataRecord(root.qa, ["approved", "nonDestructive", "recipeId"]);
  const release = ownDataRecord(root.release, [
    "ownerSigned",
    "immutableVerified",
    "supervisorBound",
    "revision",
  ]);
  if (!provider || !consent || !lane || !qa || !release)
    return deny("UNTRUSTED_EVIDENCE_FIELDS");
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
  if (root.explicitActivationRequested !== true)
    return deny("ACTIVATION_NOT_REQUESTED");
  // This is never a runnable activation grant. The device must independently
  // authenticate account billing, route binding, consent and signed runtime
  // at the point of work. Returning allowed=true here would let caller-
  // fabricated booleans be mistaken for authorization by a future consumer.
  return {
    allowed: false,
    preflightEligible: true,
    reason: "PREFLIGHT_ONLY_REVALIDATE_AT_EXECUTION",
  };
}

// Hostile getters or proxy traps are untrusted evidence, not a worker crash.
export function evaluateCloudCodingAdmission(input) {
  try {
    return assessCloudCodingAdmission(input);
  } catch {
    return { allowed: false, reason: "EVIDENCE_ACCESS_FAILED" };
  }
}
