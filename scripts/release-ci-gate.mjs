#!/usr/bin/env node
// KMJ TECHNO — fail-closed exact-commit GitHub Actions admission for signing.
// Input: a single bounded GitHub REST /commits/:sha/check-runs response on stdin.
// No repository token, mutable branch, signing action or GitHub call here.
import { pathToFileURL } from "node:url";

export const REQUIRED_RELEASE_CHECKS = Object.freeze([
  "registry_manifest",
  "verify (ubuntu-24.04)",
  "verify (windows-latest)",
  "clients",
  "distribution",
]);
const SHA = /^[a-f0-9]{40}$/;
const MAX_STDIN_BYTES = 1024 * 1024;

export function assessReleaseChecks(response, expectedSha) {
  const fail = (reason) => ({ ready: false, reason });
  if (typeof expectedSha !== "string" || !SHA.test(expectedSha))
    return fail("SOURCE_SHA_INVALID");
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    !Number.isSafeInteger(response.total_count) ||
    response.total_count < REQUIRED_RELEASE_CHECKS.length ||
    response.total_count > 100 ||
    !Array.isArray(response.check_runs) ||
    response.check_runs.length !== response.total_count
  )
    return fail("CI_RESULT_INCOMPLETE_OR_UNBOUNDED");
  const checkRuns = response.check_runs.filter(
    (run) => run?.name !== "signed_release",
  );
  if (checkRuns.length < REQUIRED_RELEASE_CHECKS.length)
    return fail("REQUIRED_CI_CHECKS_MISSING");
  // The public check run's name alone is not sufficient: require GitHub
  // Actions as author and exact commit SHA, with completed success only.
  for (const run of checkRuns) {
    if (
      !run ||
      typeof run !== "object" ||
      run.head_sha !== expectedSha ||
      run.app?.slug !== "github-actions"
    ) return fail("CI_SOURCE_OR_APP_UNTRUSTED");
    if (run.status !== "completed" || run.conclusion !== "success")
      return fail("CI_INCOMPLETE_OR_RED");
  }
  for (const name of REQUIRED_RELEASE_CHECKS) {
    if (checkRuns.filter((run) => run.name === name).length !== 1)
      return fail("CI_REQUIRED_NAME_MISSING_OR_DUPLICATED");
  }
  return {
    ready: true,
    reason: "PASS",
    checks: checkRuns.length,
    revision: expectedSha,
  };
}

async function main() {
  const expectedSha = process.argv[2];
  if (process.argv.length !== 3 || !SHA.test(expectedSha ?? ""))
    throw Error("SOURCE_SHA_INVALID");
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) throw Error("CI_RESULT_OVERSIZED");
    chunks.push(chunk);
  }
  if (total === 0) throw Error("CI_RESULT_EMPTY");
  const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  const result = assessReleaseChecks(parsed, expectedSha);
  if (!result.ready) throw Error(result.reason);
  console.log("RELEASE_EXACT_HEAD_CI=PASS");
  console.log("RELEASE_VERIFIED_CHECKS=" + result.checks);
  console.log("RELEASE_SOURCE_SHA=" + result.revision);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = String(error?.message ?? "");
    const code = /^[A-Z_]{4,64}$/.test(message) ? message : "CI_VERIFICATION_FAILED";
    console.log("RELEASE_EXACT_HEAD_CI=BLOCKED:" + code);
    process.exitCode = 2;
  }
}
