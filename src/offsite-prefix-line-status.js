// Exact-invocation, read-only numeric fault telemetry for the existing KMJ-elite
// offsite one-shot. Never returns raw journal content, paths, secrets or shell.
// An ERR-trap line is ADVISORY; it is not a backup/restore integrity proof.
export const LOCAL_PREFIX_LINE_UNKNOWN = Object.freeze({
  line: "UNKNOWN",
  journalScope: "UNAVAILABLE",
  rawJournalExposed: false,
  backupVerified: false,
  restoreVerified: false,
});

const INVOCATION = /^[a-f0-9]{32}$/;
const ALLOWED_LINE = /^LINE_(?:0[1-9]|1[0-9]|2[0-8])$/;
const RECORD = "LOCAL_PREFIX_ERR_TRAP_LINE_CANDIDATE=";
const MAX_JOURNAL = 8192;

export function parseOffsitePrefixJournal(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_JOURNAL)
    return "UNKNOWN";
  const lines = text.split("\n").filter((line) => line.startsWith(RECORD));
  // Any repeated, padded or malformed telemetry is ambiguous.
  if (lines.length !== 1) return "UNKNOWN";
  const value = lines[0].slice(RECORD.length);
  return ALLOWED_LINE.test(value) ? value : "UNKNOWN";
}

export function fixedOffsitePrefixLineStatus({ run, unit, invocationID }) {
  // The exact unit identity is fixed upstream, not selectable by the caller.
  if (
    unit?.installed !== true ||
    unit?.result !== "exit-code" ||
    unit?.execMainStatus !== "3" ||
    typeof invocationID !== "string" ||
    !INVOCATION.test(invocationID)
  )
    return LOCAL_PREFIX_LINE_UNKNOWN;

  let output;
  try {
    output = run(
      "/usr/bin/journalctl",
      [
        "--no-pager",
        "--output=cat",
        "--lines=200",
        "_SYSTEMD_INVOCATION_ID=" + invocationID,
      ],
      { timeout: 15000, maxBuffer: MAX_JOURNAL, cwd: "/" },
    );
  } catch {
    return LOCAL_PREFIX_LINE_UNKNOWN;
  }
  if (typeof output !== "string" || output.length > MAX_JOURNAL)
    return LOCAL_PREFIX_LINE_UNKNOWN;
  const line = parseOffsitePrefixJournal(output);
  return {
    line,
    journalScope: "EXACT_INVOCATION",
    rawJournalExposed: false,
    backupVerified: false,
    restoreVerified: false,
  };
}
