import { createHash } from "node:crypto";

// A concise, secret-minimizing IDE receipt. The runner attests execution state,
// not the truth of arbitrary PASS lines printed by untrusted project code.
const ALLOWED_PREFIXES = [
  "CTEST_",
  "BUILD_",
  "HARDWARE_",
  "WEBCAM_",
  "CAMERA_",
  "FISHEYE_",
  "CALIBRATION_",
  "T07_",
  "UI_QA_",
  "ORIGINAL_",
  "INTEGRATION_",
  "TEST_",
];
const ALLOWED_KEYS = new Set(["EXACT_SOURCE_SHA", "EXACT_UI_SOURCE_SHA"]);
const SENSITIVE =
  /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|BEARER|AUTH|API_KEY|KEY_FILE)/i;
const SAFE_STATUS =
  /^(?:PASS|FAIL|YES|NO|NONE|UNKNOWN|PENDING|BLOCKED|UNTOUCHED|NOT_RUN|NOT_VERIFIED|NO_RELEASE|PASS_[0-9]{1,3}_OF_[0-9]{1,3})$/;
const EXACT_SHA = /^[a-f0-9]{40}$/;
const MAX_MARKERS = 16;
const MAX_OUTPUT_BYTES = 32768;

// Numeric-only, framework-specific summaries. The source is untrusted log
// text, not an attestation of which tests actually ran. Keep the last
// summary per framework, never sum repeated banners or copy arbitrary lines.
export function compactTestSummaries(output) {
  const summaries = new Map();
  const fields = {
    passed: "passed",
    failed: "failed",
    skipped: "skipped",
    error: "errors",
    errors: "errors",
    xfailed: "xfailed",
    xpassed: "xpassed",
    deselected: "deselected",
    "subtests passed": "subtestsPassed",
    warning: "warnings",
    warnings: "warnings",
  };
  for (const raw of output.slice(-MAX_OUTPUT_BYTES).split(/\r?\n/)) {
    const line = raw.trim();
    let match =
      /^(\d{1,3})% tests passed, (\d{1,7}) tests? failed out of (\d{1,7})$/.exec(
        line,
      );
    if (match) {
      const [percent, failed, total] = match.slice(1).map(Number);
      if (percent <= 100 && failed <= total && total > 0)
        summaries.set("ctest", {
          framework: "ctest",
          total,
          failed,
          passed: total - failed,
        });
      continue;
    }
    match =
      /^test result: (?:ok|FAILED)\. (\d{1,7}) passed; (\d{1,7}) failed; (\d{1,7}) ignored; (\d{1,7}) measured; (\d{1,7}) filtered out(?:; finished in [\d.]+s)?$/.exec(
        line,
      );
    if (match) {
      const [passed, failed, ignored, measured, filteredOut] = match
        .slice(1)
        .map(Number);
      summaries.set("cargo", {
        framework: "cargo",
        passed,
        failed,
        ignored,
        measured,
        filteredOut,
      });
      continue;
    }
    match = /^(?:=+ )?(.+) in \d+(?:\.\d+)?s(?: =+)?$/.exec(line);
    if (!match) continue;
    const summary = { framework: "pytest" };
    const parts = match[1].split(", ");
    if (parts.length > 11) continue;
    let valid = true;
    for (const item of parts) {
      const count = /^(\d{1,7}) (.+)$/.exec(item);
      if (
        !count ||
        !Object.hasOwn(fields, count[2]) ||
        Object.hasOwn(summary, fields[count[2]])
      ) {
        valid = false;
        break;
      }
      summary[fields[count[2]]] = Number(count[1]);
    }
    if (valid) summaries.set("pytest", summary);
  }
  return [...summaries.values()];
}

export function compactIdeJobReceipt(job) {
  if (
    !job ||
    typeof job.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(job.id)
  )
    throw new Error("IDE_JOB_INVALID");
  const validStates = new Set([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ]);
  const state = validStates.has(job.state) ? job.state : "unknown";
  const output =
    typeof job.output === "string" ? job.output.slice(-MAX_OUTPUT_BYTES) : "";
  const markers = new Map();
  let repeatedMarkers = 0;
  for (const raw of output.split(/\r?\n/)) {
    const match = /^([A-Z][A-Za-z0-9_]{2,63})=([A-Za-z0-9_.:-]{1,80})$/.exec(
      raw.trim(),
    );
    if (!match) continue;
    const [, key, value] = match;
    if (
      SENSITIVE.test(key) ||
      !(
        ALLOWED_KEYS.has(key) ||
        ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))
      )
    )
      continue;
    // A broad key allowlist is not permission to echo arbitrary secret values.
    // Only bounded predefined statuses or pinned SHAs survive into chat.
    if (
      ALLOWED_KEYS.has(key) ? !EXACT_SHA.test(value) : !SAFE_STATUS.test(value)
    )
      continue;
    const identity = JSON.stringify([key, value]);
    if (markers.has(identity)) {
      repeatedMarkers++;
      markers.delete(identity);
    }
    markers.set(identity, { key, value });
  }
  const selected = [...markers.values()].slice(-MAX_MARKERS);
  const testSummaries = compactTestSummaries(output);
  const finished = [
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ].includes(state);
  const gate =
    typeof job.gate === "string" &&
    /^[A-Za-z0-9_:@#./ -]{1,200}$/.test(job.gate)
      ? job.gate
      : null;
  const iso = (v) =>
    typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? v : null;
  const logSha256 = createHash("sha256").update(output).digest("hex");
  const exitCode = Number.isInteger(job.exitCode) ? job.exitCode : null;
  // Tamper-evident digest over the fixed-field execution record. It binds the
  // gate label (command:variant:category@lane#head), terminal state, exit code,
  // timestamps, truncation flag and log hash. It is NOT a signature and proves
  // nothing about the truth of project output.
  const record = {
    v: 1,
    job: job.id,
    gate,
    state,
    exitCode,
    startedAt: iso(job.startedAt),
    endedAt: iso(job.endedAt),
    truncated: job.truncated === true,
    logSha256,
  };
  const receiptSha256 = createHash("sha256")
    .update(JSON.stringify(record))
    .digest("hex");
  return {
    job: job.id,
    gate,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    truncated: record.truncated,
    receiptSha256,
    state,
    exitCode: Number.isInteger(job.exitCode) ? job.exitCode : null,
    terminal: finished,
    executionSucceeded: state === "succeeded" && job.exitCode === 0,
    approvalOrDeploymentProven: false,
    evidenceScope: "LOCAL_RUNNER_AND_UNTRUSTED_PROJECT_OUTPUT",
    markers: selected,
    markersTruncated: markers.size > MAX_MARKERS,
    ...(repeatedMarkers ? { repeatedMarkers } : {}),
    ...(testSummaries.length
      ? { testSummaries, testSummariesVerified: false }
      : {}),
    logSha256,
    logTailAvailableVia: "get_job_status",
    // No caller-selected argv, cwd, environment, shell, file path, token,
    // transcript or raw command output is ever returned in a compact receipt.
  };
}
