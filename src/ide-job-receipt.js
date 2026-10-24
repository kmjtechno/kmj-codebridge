import { createHash } from "node:crypto";

// A concise, secret-minimizing IDE receipt. The runner attests execution state,
// not the truth of arbitrary PASS lines printed by untrusted project code.
const ALLOWED_PREFIXES = [
  "CTEST_", "BUILD_", "HARDWARE_", "WEBCAM_", "CAMERA_",
  "FISHEYE_", "CALIBRATION_", "T07_", "UI_QA_",
  "ORIGINAL_", "INTEGRATION_", "TEST_",
];
const ALLOWED_KEYS = new Set(["EXACT_SOURCE_SHA", "EXACT_UI_SOURCE_SHA"]);
const SENSITIVE = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|BEARER|AUTH|API_KEY|KEY_FILE)/i;
const MAX_MARKERS = 16;
const MAX_OUTPUT_BYTES = 32768;

export function compactIdeJobReceipt(job) {
  if (!job || typeof job.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(job.id))
    throw new Error("IDE_JOB_INVALID");
  const validStates = new Set([
    "queued", "running", "succeeded", "failed", "cancelled",
    "timed_out", "interrupted",
  ]);
  const state = validStates.has(job.state) ? job.state : "unknown";
  const output = typeof job.output === "string"
    ? job.output.slice(-MAX_OUTPUT_BYTES) : "";
  const markers = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]{2,63})=([A-Za-z0-9_.:-]{1,80})$/.exec(raw.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (SENSITIVE.test(key) || !(
      ALLOWED_KEYS.has(key) ||
      ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))
    )) continue;
    markers.push({ key, value });
  }
  const selected = markers.slice(-MAX_MARKERS);
  const finished = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(state);
  return {
    job: job.id,
    state,
    exitCode: Number.isInteger(job.exitCode) ? job.exitCode : null,
    terminal: finished,
    executionSucceeded: state === "succeeded" && job.exitCode === 0,
    approvalOrDeploymentProven: false,
    evidenceScope: "LOCAL_RUNNER_AND_UNTRUSTED_PROJECT_OUTPUT",
    markers: selected,
    markersTruncated: markers.length > MAX_MARKERS,
    logSha256: createHash("sha256").update(output).digest("hex"),
    logTailAvailableVia: "get_job_status",
    // No caller-selected argv, cwd, environment, shell, file path, token,
    // transcript or raw command output is ever returned in a compact receipt.
  };
}
