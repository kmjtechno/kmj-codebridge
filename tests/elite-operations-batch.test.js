import assert from "node:assert/strict";
import test from "node:test";
import {
  allowEliteOperationsRead,
  eliteOperationsBatchSummary,
  isEliteOperationsRead,
} from "../src/elite-operations-batch.js";

const scope = {
  device: "kmj-elite-main-platform",
  project: "kmj-main-platform",
};
const candidateSha = "a".repeat(40);
const stagingTool = "supervisor_main_platform_staging_status";
const productionTool = "supervisor_main_platform_production_status";
const maintenanceTool = "supervisor_main_platform_maintenance_status";
const receipts = [
  {
    tool: stagingTool,
    ok: true,
    value: {
      approvedSha: candidateSha,
      currentSha: candidateSha,
      productionUnchanged: true,
    },
  },
  {
    tool: productionTool,
    ok: true,
    value: {
      approvedSha: candidateSha,
      nginxActive: true,
      phpFpmActive: true,
      readyToActivate: true,
    },
  },
  {
    tool: maintenanceTool,
    ok: true,
    value: { recentBackupVerified: true, restoreVerified: true },
  },
];

test("only the three existing read profiles are admitted on Elite", () => {
  for (const { tool } of receipts) {
    assert.equal(isEliteOperationsRead(tool), true);
    assert.equal(allowEliteOperationsRead(scope, { tool, args: {} }), true);
    assert.equal(
      allowEliteOperationsRead(scope, { tool, args: { path: "/tmp" } }),
      false,
    );
    assert.equal(
      allowEliteOperationsRead({ ...scope, device: "google-vps" }, { tool }),
      false,
    );
    assert.equal(
      allowEliteOperationsRead({ ...scope, project: "kmj-cloudos" }, { tool }),
      false,
    );
  }
  assert.equal(
    isEliteOperationsRead("supervisor_main_platform_staging_deploy"),
    false,
  );
});

test("complete batch is advisory and cannot authorize production", () => {
  const result = eliteOperationsBatchSummary(scope, receipts);
  assert.equal(result.status, "HOST_REVIEW_REQUIRED");
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.deploymentVerified, false);
  assert.equal(result.exactMainCiVerified, false);
  assert.equal(result.receiptSnapshotAtomic, false);
  assert.equal(result.signingAuthorized, false);
});

test("partial or duplicate observations cannot form an aggregate", () => {
  assert.equal(eliteOperationsBatchSummary(scope, receipts.slice(1)), null);
  assert.equal(
    eliteOperationsBatchSummary(scope, [...receipts, receipts[0]]),
    null,
  );
  assert.equal(
    eliteOperationsBatchSummary({ ...scope, device: "google-vps" }, receipts),
    null,
  );
});

test("failed status or conflicting staging evidence blocks readiness", () => {
  const result = eliteOperationsBatchSummary(scope, [
    {
      ...receipts[0],
      value: {
        ...receipts[0].value,
        productionUnchanged: false,
      },
    },
    receipts[1],
    { ...receipts[2], ok: false, error: "SUPERVISOR_TIMEOUT" },
  ]);
  assert.equal(result.status, "BLOCKED_OR_UNKNOWN");
  assert.deepEqual(result.blockers, [
    "STAGING_PRODUCTION_CONTINUITY_UNVERIFIED",
    "BACKUP_UNVERIFIED",
    "RESTORE_UNVERIFIED",
  ]);
  assert.equal(result.executionAuthorized, false);
});
