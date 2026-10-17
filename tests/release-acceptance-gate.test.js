import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessReleaseEvidence,
  readReleaseEvidence,
} from "../scripts/release-acceptance-gate.mjs";

const SHA = "a".repeat(40);
const SECOND = "b".repeat(40);
const REQUIRED = [
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
];

function goodEvidence() {
  return {
    schema: 1,
    source: { revision: SHA },
    ci: {
      revision: SHA,
      checks: REQUIRED.map((name) => ({
        name,
        headSha: SHA,
        status: "completed",
        conclusion: "success",
      })),
    },
    candidate: {
      revision: SHA,
      sequence: 11,
      archiveSha256: "c".repeat(64),
      ownerSignatureVerification: "PASS",
      archiveDigestVerification: "PASS",
    },
    hosted: {
      revision: SHA,
      status: "ok",
      githubReady: true,
      githubReadinessState: "ready",
    },
    operator: {
      stagedRevision: SHA,
      stagedSequence: 11,
      acceptedSequence: 10,
      preflight: "PASS",
      browserQa: "PASS",
      dispatchReceiptQa: "PASS",
      rollbackAvailable: true,
      activeJobs: 0,
      renderTcpReachable: true,
    },
  };
}

test("complete assertions permit owner review, never automatic activation", () => {
  const report = assessReleaseEvidence(goodEvidence());
  assert.equal(report.assessment, "READY_FOR_MANUAL_OWNER_VERIFICATION");
  assert.deepEqual(report.blockers, []);
  assert.match(report.disclaimer, /Never publish, sign, merge or activate/);
});

test("fails closed for rate-limited hosted GitHub and current red CI", () => {
  const evidence = goodEvidence();
  evidence.ci.checks.find((x) => x.name === "github_bridge").conclusion =
    "failure";
  evidence.hosted.githubReady = false;
  evidence.hosted.githubReadinessState = "failed";
  const report = assessReleaseEvidence(evidence);
  assert.equal(report.assessment, "BLOCKED");
  assert(report.blockers.includes("CI_CHECK_NOT_GREEN:github_bridge"));
  assert(report.blockers.includes("HOSTED_EXACT_SHA_OR_READINESS_NOT_VERIFIED"));
});

test("never trusts a successful check for a different head SHA", () => {
  const evidence = goodEvidence();
  evidence.ci.checks[0].headSha = SECOND;
  assert(
    assessReleaseEvidence(evidence).blockers.includes(
      "CI_CHECK_NOT_GREEN:registry_manifest",
    ),
  );
  evidence.ci.revision = SECOND;
  assert(
    assessReleaseEvidence(evidence).blockers.includes("EXACT_HEAD_CI_MISSING"),
  );
});

test("requires all checks including newly introduced extra checks", () => {
  const evidence = goodEvidence();
  evidence.ci.checks.pop();
  assert(
    assessReleaseEvidence(evidence).blockers.includes(
      "CI_CHECK_MISSING_OR_DUPLICATE:deployment_parity",
    ),
  );
  evidence.ci.checks.push({
    name: "new_security",
    headSha: SHA,
    status: "queued",
    conclusion: null,
  });
  assert(
    assessReleaseEvidence(evidence).blockers.includes(
      "CI_ADDITIONAL_CHECK_NOT_GREEN",
    ),
  );
});

test("unsigned candidates and missing rollback block assessment", () => {
  const evidence = goodEvidence();
  evidence.candidate.ownerSignatureVerification = "UNKNOWN";
  evidence.operator.rollbackAvailable = false;
  evidence.operator.activeJobs = 1;
  assert(
    assessReleaseEvidence(evidence).blockers.includes(
      "OWNER_SIGNATURE_AND_ARCHIVE_EVIDENCE_MISSING",
    ),
  );
  assert(
    assessReleaseEvidence(evidence).blockers.includes(
      "OPERATOR_SAFE_ACTIVATION_EVIDENCE_INCOMPLETE",
    ),
  );
});

test("VPS transport timeout blocks even if GitHub reports ready", () => {
  const evidence = goodEvidence();
  evidence.operator.renderTcpReachable = false;
  assert(
    assessReleaseEvidence(evidence).blockers.includes(
      "VPS_RENDER_NETWORK_UNVERIFIED",
    ),
  );
});

test("unknown or malformed evidence is never considered ready", () => {
  for (const value of [null, {}, [], { schema: 2 }, { schema: 1 }]) {
    assert.equal(assessReleaseEvidence(value).assessment, "BLOCKED");
  }
});

test("evidence reader rejects symlinks and oversized files", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, "evidence.json");
  const link = path.join(temp, "link.json");
  fs.writeFileSync(file, JSON.stringify(goodEvidence()));
  fs.symlinkSync(file, link);
  assert.equal(readReleaseEvidence(file).schema, 1);
  assert.throws(() => readReleaseEvidence(link), /EVIDENCE_FILE_INVALID/);
  fs.writeFileSync(file, Buffer.alloc(256 * 1024 + 1));
  assert.throws(() => readReleaseEvidence(file), /EVIDENCE_FILE_INVALID/);
});
