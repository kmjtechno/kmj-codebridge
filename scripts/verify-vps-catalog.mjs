#!/usr/bin/env node
// Credential-free release smoke for the owner VPS, not a Render fallback.
import { pathToFileURL } from "node:url";
import {
  ENDPOINTS,
  REQUIRED_TOOLS,
  probeWithWarmup,
  probeServerCommit,
  verifyCriticalToolSchemas,
} from "./verify-public-mcp-catalog.mjs";

const FULL_SHA = /^[a-f0-9]{40}$/;

export function assertVpsDeployedCommit(commit, expected = "") {
  if (typeof commit !== "string" || !FULL_SHA.test(commit)) {
    throw new Error("VPS_COMMIT_UNVERIFIED");
  }
  if (expected !== "" && (!FULL_SHA.test(expected) || expected !== commit)) {
    const error = new Error("VPS_COMMIT_MISMATCH");
    // Commit IDs are public release metadata. Only attach them after both
    // inputs pass the strict full-SHA validation; never echo arbitrary env data.
    if (FULL_SHA.test(expected)) {
      error.expectedCommit = expected;
      error.observedCommit = commit;
    }
    throw error;
  }
  return commit;
}

export async function verifyVpsPublicMcp() {
  const catalog = await probeWithWarmup(
    ENDPOINTS.production,
    fetch,
    undefined,
    { withSchemas: true },
  );
  if (!(catalog?.names instanceof Set) || catalog.names.size < 100) {
    throw new Error("VPS_CATALOG_INCOMPLETE");
  }
  if (REQUIRED_TOOLS.some((name) => !catalog.names.has(name))) {
    throw new Error("VPS_REQUIRED_TOOL_MISSING");
  }
  verifyCriticalToolSchemas(catalog);

  const commit = assertVpsDeployedCommit(
    await probeServerCommit(ENDPOINTS.production),
    process.env.EXPECT_DEPLOYED_COMMIT ?? "",
  );
  const pushed = process.env.GITHUB_SHA ?? "";
  if (FULL_SHA.test(pushed) && pushed !== commit) {
    // GitHub main can move before the separately approved VPS release.
    // A scheduled smoke must not silently claim exact source parity.
    console.log("VPS_SOURCE_PARITY=NOT_CURRENT_RELEASE");
  } else if (FULL_SHA.test(pushed)) {
    console.log("VPS_SOURCE_PARITY=CURRENT");
  }
  console.log(
    "KMJ_VPS_MCP_SMOKE=PASS tools=" +
      catalog.names.size +
      " criticalSchemas=PASS commit=" +
      commit,
  );
  return { count: catalog.names.size, commit };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  verifyVpsPublicMcp().catch((error) => {
    const known = new Set([
      "VPS_COMMIT_UNVERIFIED",
      "VPS_COMMIT_MISMATCH",
      "VPS_CATALOG_INCOMPLETE",
      "VPS_REQUIRED_TOOL_MISSING",
      "MCP_CATALOG_PROBE_UNAVAILABLE",
      "MCP_CATALOG_INCOMPLETE",
      "MCP_CRITICAL_TOOL_MISSING",
      "MCP_CRITICAL_SCHEMA_MISSING",
      "MCP_CRITICAL_SCHEMA_INVALID",
    ]);
    const code = known.has(error?.message)
      ? error.message
      : "VPS_MCP_VERIFICATION_FAILED";
    console.error("KMJ_VPS_MCP_SMOKE=FAIL " + code);
    if (
      code === "VPS_COMMIT_MISMATCH" &&
      FULL_SHA.test(error?.expectedCommit) &&
      FULL_SHA.test(error?.observedCommit)
    ) {
      console.error("KMJ_VPS_MCP_COMMIT_EXPECTED=" + error.expectedCommit);
      console.error("KMJ_VPS_MCP_COMMIT_OBSERVED=" + error.observedCommit);
    }
    process.exitCode = 1;
  });
}
