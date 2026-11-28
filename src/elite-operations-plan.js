// Advisory operations readiness only. Never use a returned plan as authority
// to execute a command. The Elite host must independently authenticate owner
// grants, attest the fixed adapters and verify their evidence under its lock.
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FRESH_MS = 120_000;

const profiles = Object.freeze({
  toolkit_install: Object.freeze(["reviewed_toolkit_pin"]),
  database_isolation: Object.freeze([
    "toolkit_installed",
    "database_inventory",
  ]),
  backup: Object.freeze(["toolkit_installed", "production_identity"]),
  restore_rehearsal: Object.freeze(["backup_verified", "database_isolated"]),
  staging_prepare: Object.freeze([
    "exact_main_ci",
    "database_isolated",
    "backup_verified",
    "restore_verified",
  ]),
  staging_activate: Object.freeze(["staging_sealed", "staging_isolated"]),
  authenticated_qa: Object.freeze(["staging_live", "staging_isolated"]),
  production_deploy: Object.freeze([
    "exact_main_ci",
    "backup_verified",
    "restore_verified",
    "database_isolated",
    "staging_live",
    "authenticated_qa_pass",
    "rollback_ready",
  ]),
  production_readback: Object.freeze(["production_activation_receipt"]),
});

function validSha(value) {
  return typeof value === "string" && SHA.test(value);
}

export function eliteOperationsCatalog() {
  return Object.entries(profiles).map(([profile, requiredEvidence]) => ({
    profile,
    requiredEvidence: [...requiredEvidence],
    executionEnabled: false,
    host: "kmj-elite",
    project: "kmj-main-platform",
  }));
}

export function planEliteOperation(input = {}) {
  const blocked = (reason) => ({
    status: "BLOCKED",
    reason,
    executionAuthorized: false,
    operationAttempted: false,
  });
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "profile",
          "host",
          "project",
          "candidateSha",
          "currentSha",
          "observations",
          "now",
        ].includes(key),
    )
  )
    return blocked("INVALID_REQUEST");
  const {
    profile,
    host,
    project,
    candidateSha,
    currentSha,
    observations,
    now,
  } = input;
  if (
    typeof profile !== "string" ||
    !Object.hasOwn(profiles, profile) ||
    host !== "kmj-elite" ||
    project !== "kmj-main-platform" ||
    !validSha(candidateSha) ||
    !validSha(currentSha) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Array.isArray(observations) ||
    observations.length > 32
  )
    return blocked("INVALID_SCOPE_OR_EVIDENCE");
  const required = profiles[profile];
  const byKind = new Map();
  for (const item of observations) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.kind !== "string" ||
      !required.includes(item.kind) ||
      byKind.has(item.kind) ||
      item.host !== host ||
      item.project !== project ||
      item.candidateSha !== candidateSha ||
      item.currentSha !== currentSha ||
      typeof item.digest !== "string" ||
      !DIGEST.test(item.digest) ||
      !Number.isSafeInteger(item.observedAt) ||
      item.observedAt > now ||
      now - item.observedAt > FRESH_MS ||
      item.status !== "PASS"
    )
      return blocked("EVIDENCE_INVALID_OR_STALE");
    byKind.set(item.kind, item);
  }
  const missing = required.filter((kind) => !byKind.has(kind));
  return {
    profile,
    candidateSha,
    currentSha,
    status: missing.length ? "EVIDENCE_PENDING" : "HOST_REVIEW_REQUIRED",
    missing,
    ownerGrantRequired: true,
    executionAuthorized: false,
    operationAttempted: false,
  };
}
