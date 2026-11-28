import { reviewHarnessGuard } from "./agent-harness-guard.js";

const SHA = /^[a-f0-9]{40}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const DOC = /^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/;

function decision(state, details = {}) {
  return {
    state,
    ...details,
    approvalSubmitted: false,
    mergeAuthorized: false,
  };
}

// This is a read-only review routing decision, not a GitHub approval.
// Inputs must be collected by a trusted adapter, not taken from PR content.
export function planIndependentReview({
  pr,
  evidence,
  policy,
  identity,
  now = Date.now(),
}) {
  if (
    !pr ||
    pr.state !== "open" ||
    pr.draft !== false ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    !SHA.test(pr.head ?? "") ||
    !SHA.test(pr.base ?? "") ||
    !policy ||
    policy.enabled !== true ||
    policy.repository !== pr.repository ||
    policy.baseRef !== pr.baseRef ||
    !Number.isFinite(now) ||
    !Number.isFinite(policy.expiresAt) ||
    now >= policy.expiresAt
  )
    return decision("OWNER_POLICY_OR_PR_UNVERIFIED");
  if (
    !evidence ||
    evidence.complete !== true ||
    evidence.head !== pr.head ||
    evidence.base !== pr.base ||
    evidence.repository !== pr.repository ||
    evidence.number !== pr.number ||
    !Number.isFinite(evidence.observedAt) ||
    evidence.observedAt > now ||
    now - evidence.observedAt > 120000 ||
    !Array.isArray(evidence.files) ||
    evidence.files.length !== pr.changedFiles ||
    evidence.files.some(
      (file) => file.status !== "modified" && file.status !== "added",
    ) ||
    typeof evidence.patch !== "string" ||
    evidence.patch.length === 0
  )
    return decision("EXACT_DIFF_UNVERIFIED");

  let guard;
  try {
    guard = reviewHarnessGuard({
      files: evidence.files.map((file) => file.path),
      patch: evidence.patch,
    });
  } catch {
    return decision("EXACT_DIFF_UNVERIFIED");
  }

  const common = {
    head: pr.head,
    base: pr.base,
    requiredGates: guard.requiredGates,
    signals: guard.signals,
  };
  // Never treat a regex risk screen as a semantic security review.
  if (
    guard.risk !== "STANDARD_MANUAL_REVIEW" ||
    !evidence.files.every((file) => DOC.test(file.path))
  )
    return decision("PROTECTED_OWNER_OR_CODEOWNER_REVIEW", common);

  // Even documentation-only changes require actual current CODEOWNERS
  // and branch rules to permit the no-owner path. This planner cannot
  // weaken those rules or interpret arbitrary CODEOWNERS patterns.
  if (
    policy.docsOnlyNoOwnerVerified !== true ||
    evidence.branchRulesVerified !== true ||
    evidence.noRequiredOwnerForFiles !== true
  )
    return decision("OWNER_REVIEW_REQUIRED", common);

  if (
    !identity ||
    identity.verified !== true ||
    identity.enrolled !== true ||
    identity.repository !== pr.repository ||
    !LOGIN.test(identity.login ?? "") ||
    !LOGIN.test(pr.author ?? "") ||
    !LOGIN.test(pr.executor ?? "") ||
    identity.login.toLowerCase() === pr.author.toLowerCase() ||
    identity.login.toLowerCase() === pr.executor.toLowerCase() ||
    identity.login !== policy.reviewerLogin
  )
    return decision("INDEPENDENT_REVIEWER_UNVERIFIED", common);

  return decision("READY_FOR_INDEPENDENT_DOCS_REVIEW", {
    ...common,
    // Review work can start during CI. Actual merge remains separate.
    ciCanRemainPending: true,
  });
}
