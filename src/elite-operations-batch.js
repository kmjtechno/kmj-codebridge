import { summarizeEliteReadback } from "./elite-operations-readback.js";

const OPERATIONS = Object.freeze([
  "supervisor_main_platform_staging_status",
  "supervisor_main_platform_production_status",
  "supervisor_main_platform_maintenance_status",
]);

export function isEliteOperationsRead(tool) {
  return OPERATIONS.includes(tool);
}

// This is a read-only extension of existing per-tool authorization.
// Neither batch arguments nor a batch result can authorize an operation.
export function allowEliteOperationsRead(scope, call) {
  return (
    scope.device === "kmj-elite-main-platform" &&
    scope.project === "kmj-main-platform" &&
    isEliteOperationsRead(call.tool) &&
    Object.keys(call.args ?? {}).length === 0
  );
}

export function eliteOperationsBatchSummary(scope, results) {
  if (
    scope.device !== "kmj-elite-main-platform" ||
    scope.project !== "kmj-main-platform"
  )
    return null;
  const matches = OPERATIONS.map((tool) =>
    results.filter((entry) => entry.tool === tool),
  );
  // Require exactly one result per fixed read. Do not choose the most
  // favorable result when a caller asks for duplicate observations.
  if (matches.some((entries) => entries.length !== 1)) return null;
  const [staging, production, maintenance] = matches.map(([entry]) =>
    entry.ok === true ? entry.value : null,
  );
  return {
    ...summarizeEliteReadback({
      candidateSha: production?.approvedSha,
      staging,
      production,
      maintenance,
    }),
    source: "AUTHORIZED_SUPERVISOR_READ_BATCH",
    exactMainCiVerified: false,
    receiptSnapshotAtomic: false,
    signingAuthorized: false,
  };
}
