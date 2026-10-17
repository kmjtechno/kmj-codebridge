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

export function compactReadBatchResult(row) {
  if (!row || typeof row !== "object" || typeof row.key !== "string" || typeof row.tool !== "string")
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
