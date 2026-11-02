// Evidence-only pre-activation gate. Never starts services, signs or deploys.
// The caller MUST obtain bundle from verifySignedReleaseBundle; a JSON claim
// of CRYPTOGRAPHICALLY_VERIFIED is not itself cryptographic evidence.
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const RELEASE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$/;

export function assessSignedStableCanary({
  bundle,
  expectedSha,
  runtime,
  operator,
} = {}) {
  const blockers = [];
  const fail = (code) => blockers.push(code);
  if (
    bundle?.verdict !== "CRYPTOGRAPHICALLY_VERIFIED" ||
    bundle?.signatureAlgorithm !== "Ed25519" ||
    bundle?.archiveAlgorithm !== "SHA-256" ||
    bundle?.channel !== "stable" ||
    !SHA.test(bundle?.revision ?? "") ||
    !HASH.test(bundle?.archiveSha256 ?? "") ||
    !Number.isSafeInteger(bundle?.sequence) ||
    bundle.sequence < 1 ||
    !Number.isSafeInteger(bundle?.archiveBytes) ||
    bundle.archiveBytes < 1
  )
    fail("SIGNED_STABLE_BUNDLE_NOT_VERIFIED");
  if (!SHA.test(expectedSha ?? "") || bundle?.revision !== expectedSha)
    fail("EXACT_SOURCE_SHA_MISMATCH");

  const activeSha = runtime?.activeSha;
  const activeRelease = runtime?.activeRelease;
  if (
    !SHA.test(activeSha ?? "") ||
    !RELEASE.test(activeRelease ?? "") ||
    !activeRelease.endsWith(`-${activeSha?.slice(0, 12)}`) ||
    activeSha === expectedSha ||
    runtime?.gatewayActive !== true ||
    runtime?.agentActive !== true
  )
    fail("CURRENT_RUNTIME_IDENTITY_UNVERIFIED");
  if (
    runtime?.signedUpdaterInstalled !== true ||
    runtime?.fixedOperatorUnitAttested !== true ||
    runtime?.gatewayConfigVerified !== true
  )
    fail("PROTECTED_OPERATOR_PATH_UNVERIFIED");
  if (
    !Number.isSafeInteger(runtime?.acceptedSequence) ||
    runtime.acceptedSequence < 0 ||
    !(bundle?.sequence > runtime.acceptedSequence)
  )
    fail("ANTI_ROLLBACK_SEQUENCE_UNVERIFIED");
  if (
    operator?.stagedSha !== expectedSha ||
    operator?.stagedArchiveSha256 !== bundle?.archiveSha256 ||
    operator?.stagedSequence !== bundle?.sequence ||
    !HASH.test(operator?.approvalDigest ?? "") ||
    operator?.ownerApprovalVerified !== true ||
    operator?.rollbackTarget !== activeRelease ||
    operator?.rollbackDrillVerified !== true ||
    operator?.stagingHealthVerified !== true ||
    operator?.unitPolicyVerified !== true
  )
    fail("OWNER_STAGING_ROLLBACK_RECEIPTS_MISSING");

  return {
    verdict: blockers.length ? "BLOCKED" : "READY_FOR_PROTECTED_OWNER_REVIEW",
    blockers,
    expectedSha: SHA.test(expectedSha ?? "") ? expectedSha : null,
    activationAuthorized: false,
    productionLive: false,
    note: "Operator/runtime receipts are untrusted assertions in this helper. Reverify under protected owner authority immediately before activation; verify actual live SHA and rollback independently afterward.",
  };
}
