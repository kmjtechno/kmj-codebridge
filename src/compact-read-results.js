import { createHash } from "node:crypto";

// Small, model-independent projection of authenticated, already-executed
// READ results. Never attempts to summarize private text with an LLM.
const HINT_FIELDS = [
  "status",
  "state",
  "ready",
  "dirty",
  "blocked",
  "available",
  "writable",
  "revision",
  "activeCount",
  "running",
  "queued",
  "failed",
  "succeeded",
  "total",
  "count",
];
const SAFE_STATUS = new Set([
  "ok",
  "pass",
  "fail",
  "failed",
  "blocked",
  "unknown",
  "ready",
  "running",
  "queued",
  "waiting",
  "succeeded",
  "cancelled",
  "offline",
  "online",
  "clean",
  "dirty",
  "disabled",
  "enabled",
]);
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function visibleValue(field, value) {
  if (typeof value === "boolean") return value;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1000000000
  )
    return value;
  if (
    (field === "status" || field === "state") &&
    typeof value === "string" &&
    SAFE_STATUS.has(value.toLowerCase())
  )
    return value.toLowerCase();
  return undefined;
}

// Preserve useful operational facts from known tool schemas without copying
// branch names, paths, filenames, error messages, or arbitrary nested text.
const COUNT_LIMIT = 1000000000;
const countValue = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= COUNT_LIMIT;
const CONFLICT = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function gitStatusHints(status) {
  if (typeof status !== "string" || Buffer.byteLength(status) > 32768)
    return {};
  const lines = status.split("\n");
  const header = lines.shift();
  if (!header.startsWith("## ")) return {};
  if (lines.at(-1) === "") lines.pop();
  let tracked = 0;
  let untracked = 0;
  let conflicts = 0;
  for (const line of lines) {
    if (line.length < 4 || line[2] !== " ") return {};
    const code = line.slice(0, 2);
    if (code === "??") {
      untracked++;
    } else if (/^[ MADRCUT]{2}$/.test(code) && code !== "  ") {
      tracked++;
      if (CONFLICT.has(code)) conflicts++;
    } else {
      // Do not misreport malformed or incomplete data as a clean tree.
      return {};
    }
  }
  const hints = {
    gitDirty: tracked + untracked > 0,
    gitTrackedRows: tracked,
    gitUntrackedRows: untracked,
    gitConflictRows: conflicts,
  };
  // Only expose explicit numeric divergence. Never include branch text.
  const divergence =
    / \[(?:ahead ([0-9]{1,10})(?:, behind ([0-9]{1,10}))?|behind ([0-9]{1,10}))\]$/.exec(
      header,
    );
  if (divergence) {
    const ahead = Number(divergence[1] ?? 0);
    const behind = Number(divergence[2] ?? divergence[3] ?? 0);
    if (countValue(ahead) && countValue(behind)) {
      hints.gitAhead = ahead;
      hints.gitBehind = behind;
    }
  }
  return hints;
}

function operationalHints(tool, value) {
  if (tool === "git_status") return gitStatusHints(value.status);
  if (tool === "project_snapshot") {
    const git = value.git;
    const hints = {};
    if (typeof git?.available === "boolean") hints.gitAvailable = git.available;
    if (git?.available === true)
      Object.assign(hints, gitStatusHints(git.status));
    if (typeof value.entriesTruncated === "boolean")
      hints.entriesTruncated = value.entriesTruncated;
    return hints;
  }
  if (tool === "execution_capacity") {
    const hints = {};
    if (typeof value.constrained === "boolean")
      hints.constrained = value.constrained;
    for (const key of [
      "configuredMaxConcurrent",
      "effectiveMaxConcurrent",
      "activeJobs",
      "queuedJobs",
      "queueLimit",
      "journalRemaining",
      "archiveRemaining",
    ]) {
      if (countValue(value[key])) hints[key] = value[key];
    }
    if (
      typeof value.blocked === "boolean" &&
      countValue(value.effectiveMaxConcurrent) &&
      countValue(value.activeJobs)
    )
      hints.availableAuthorizedSlots = value.blocked
        ? 0
        : Math.max(0, value.effectiveMaxConcurrent - value.activeJobs);
    return hints;
  }
  return {};
}

export function compactReadBatchResult(row) {
  if (
    !row ||
    typeof row !== "object" ||
    typeof row.key !== "string" ||
    typeof row.tool !== "string"
  )
    throw new Error("COMPACT_READ_INVALID_ROW");
  if (row.ok !== true) {
    return {
      key: row.key,
      tool: row.tool,
      ok: false,
      error:
        typeof row.error === "string" && CODE.test(row.error)
          ? row.error
          : "TOOL_CALL_FAILED",
    };
  }
  const serialized = JSON.stringify(row.value ?? null);
  if (typeof serialized !== "string")
    throw new Error("COMPACT_READ_INVALID_VALUE");
  const value = row.value;
  const hints = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const name of HINT_FIELDS) {
      const safe = visibleValue(name, value[name]);
      if (safe !== undefined) hints[name] = safe;
    }
    Object.assign(hints, operationalHints(row.tool, value));
  }
  return {
    key: row.key,
    tool: row.tool,
    ok: true,
    responseMode: "compact",
    contentSha256: createHash("sha256").update(serialized).digest("hex"),
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    shape: Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value === "object"
          ? "object"
          : "scalar",
    ...(Array.isArray(value) ? { itemCount: value.length } : {}),
    hints,
    detailsReturned: false,
    detailsRetained: false,
    detailsRequireNewAuthorizedToolCall: true,
    externallyVerified: false,
  };
}

/**
 * Opt-in adaptive output. A compact receipt is returned only when it yields
 * a material model-visible byte saving. Small responses remain intact so
 * consumers do not need to spend another tool call to inspect trivial facts.
 * This compares UTF-8 JSON bytes, not provider tokens or inference credits.
 * Tool failures are always code-only (never forward untrusted error details).
 */
export function adaptiveReadBatchResult(row) {
  if (
    !row ||
    typeof row !== "object" ||
    typeof row.key !== "string" ||
    typeof row.tool !== "string"
  )
    throw new Error("COMPACT_READ_INVALID_ROW");
  if (row.ok !== true) return compactReadBatchResult(row);

  const full = JSON.stringify(row);
  if (typeof full !== "string") throw new Error("COMPACT_READ_INVALID_VALUE");
  const fullBytes = Buffer.byteLength(full, "utf8");
  if (fullBytes <= 512) return row;

  const compact = compactReadBatchResult(row);
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
  if (fullBytes - compactBytes >= 192 && compactBytes * 5 <= fullBytes * 4)
    return compact;
  return row;
}
