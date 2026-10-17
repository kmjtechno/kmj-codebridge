// KMJ TECHNO — evidence-only release assessment. This is NOT a signature
// verifier, production deploy command, or authorization to activate.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const REQUIRED = Object.freeze([
  "registry_manifest",
  "verify (ubuntu-24.04)",
  "verify (windows-latest)",
  "clients",
  "distribution",
  "gateway",
  "github_bridge",
  "public_oauth",
  "public_mcp_catalog",
  "deployment_parity",
]);

export function assessReleaseEvidence(evidence) {
  const blockers = [];
  const fail = (code) => blockers.push(code);
  if (!evidence || typeof evidence !== "object" || evidence.schema !== 1) {
    return { assessment: "BLOCKED", blockers: ["EVIDENCE_SCHEMA_INVALID"] };
  }
  const source = evidence.source;
  const ci = evidence.ci;
  const candidate = evidence.candidate;
  const hosted = evidence.hosted;
  const operator = evidence.operator;
  const sha = source?.revision;
  if (!SHA.test(sha ?? "")) fail("SOURCE_REVISION_INVALID");
  if (ci?.revision !== sha || !Array.isArray(ci?.checks)) {
    fail("EXACT_HEAD_CI_MISSING");
  } else {
    for (const name of REQUIRED) {
      const matches = ci.checks.filter((run) => run?.name === name);
      if (matches.length === 0) {
        fail("CI_CHECK_MISSING:" + name);
      } else if (
        matches.some(
          (check) =>
            check.headSha !== sha ||
            check.status !== "completed" ||
            check.conclusion !== "success",
        )
      ) {
        fail("CI_CHECK_NOT_GREEN:" + name);
      }
    }
    if (
      ci.checks.some(
        (check) =>
          !check ||
          check.headSha !== sha ||
          check.status !== "completed" ||
          check.conclusion !== "success",
      )
    ) {
      fail("CI_ADDITIONAL_CHECK_NOT_GREEN");
    }
  }
  if (
    candidate?.revision !== sha ||
    !Number.isSafeInteger(candidate?.sequence) ||
    candidate.sequence < 1 ||
    !DIGEST.test(candidate?.archiveSha256 ?? "")
  ) {
    fail("SIGNED_CANDIDATE_IDENTITY_INVALID");
  }
  if (
    candidate?.ownerSignatureVerification !== "PASS" ||
    candidate?.archiveDigestVerification !== "PASS"
  ) {
    fail("OWNER_SIGNATURE_AND_ARCHIVE_EVIDENCE_MISSING");
  }
  if (
    hosted?.revision !== sha ||
    hosted?.status !== "ok" ||
    hosted?.githubReady !== true ||
    hosted?.githubReadinessState !== "ready"
  ) {
    fail("HOSTED_EXACT_SHA_OR_READINESS_NOT_VERIFIED");
  }
  if (
    operator?.stagedRevision !== sha ||
    operator?.stagedSequence !== candidate?.sequence ||
    !Number.isSafeInteger(operator?.acceptedSequence) ||
    operator.acceptedSequence >= candidate?.sequence ||
    operator.preflight !== "PASS" ||
    operator.browserQa !== "PASS" ||
    operator.dispatchReceiptQa !== "PASS" ||
    operator.rollbackAvailable !== true ||
    operator.activeJobs !== 0
  ) {
    fail("OPERATOR_SAFE_ACTIVATION_EVIDENCE_INCOMPLETE");
  }
  if (operator?.renderTcpReachable !== true) {
    fail("VPS_RENDER_NETWORK_UNVERIFIED");
  }
  return {
    assessment:
      blockers.length === 0 ? "READY_FOR_MANUAL_OWNER_VERIFICATION" : "BLOCKED",
    blockers,
    sourceRevision: SHA.test(sha ?? "") ? sha : null,
    disclaimer:
      "Evidence fields are assertions, not cryptographic or live network verification. Never publish, sign, merge or activate automatically from this report.",
  };
}

export function readReleaseEvidence(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) {
    throw Error("EVIDENCE_FILE_INVALID");
  }
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw Error("USAGE");
    const assessment = assessReleaseEvidence(
      readReleaseEvidence(process.argv[2]),
    );
    console.log(JSON.stringify(assessment, null, 2));
    if (assessment.assessment === "BLOCKED") process.exitCode = 1;
  } catch {
    console.error("RELEASE_EVIDENCE_INVALID");
    process.exitCode = 2;
  }
}
