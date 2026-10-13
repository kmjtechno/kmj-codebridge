import { createHash } from "node:crypto";
import { redact } from "./jobs.js";

// CI output is third-party content. It can contain credentials, personal
// information and prompt-injection. Keep only a tiny diagnostic excerpt.
const DIAGNOSTIC =
  /(?:\berror\b|\bfatal\b|\bfail(?:ed|ure)?\b|exception|undefined|cannot|not found|does not exist|failed asserting|expects .* given|typeerror|syntaxerror|✖|×|\bTS\d{4}\b|\bE\d{3,5}\b)/i;
const SECRET_INDICATOR =
  /\b(?:authorization|bearer|basic|cookie|set-cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|session[_-]?id)\b/i;
const KEY_VALUE = /\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/i;
const UNSAFE_URL = /https?:\/\/\S+/i;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const MAX_TEXT = 96 * 1024;
const MAX_LINES = 18;

export function sanitizeCiLog(text, maxLines = MAX_LINES) {
  if (
    typeof text !== "string" ||
    !Number.isInteger(maxLines) ||
    maxLines < 1 ||
    maxLines > MAX_LINES
  )
    return { lines: [], truncated: false };
  const limited = text.slice(0, MAX_TEXT);
  const input = limited
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .split("\n");
  const seen = new Set();
  const lines = [];
  let more = false;
  for (const raw of input) {
    if (!DIAGNOSTIC.test(raw)) continue;
    if (raw.length > 400 || UNSAFE_URL.test(raw) || EMAIL.test(raw)) continue;
    // The broad skip is intentional: even a known redactor cannot safely
    // infer every proprietary provider credential syntax or session cookie.
    if (SECRET_INDICATOR.test(raw) || KEY_VALUE.test(raw)) continue;
    const line = redact(raw).trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    if (lines.length >= maxLines) {
      more = true;
      break;
    }
    lines.push(line);
  }
  return {
    lines,
    truncated: text.length > MAX_TEXT || more,
  };
}

const RULES = [
  {
    code: "PHP_STATIC_ANALYSIS",
    pattern:
      /phpstan|larastan|property .*does not exist|expects .* given|call to an undefined method/i,
    gate: "type",
    suggestion:
      "Inspect the exact PHPStan diagnostic and related PHP model/types on an isolated branch; run the configured PHPStan gate before a reviewable PR.",
  },
  {
    code: "PHP_FORMATTING",
    pattern: /pint|php_cs_fixer|php-cs-fixer|php style/i,
    gate: "lint",
    suggestion:
      "Check the PHP formatter diff in an isolated worktree; run only the project's pre-approved Pint gate and review its changes.",
  },
  {
    code: "TYPESCRIPT",
    pattern: /\btypescript\b|\bts\d{4}\b|typecheck|\btsc\b/i,
    gate: "type",
    suggestion:
      "Read the reported TypeScript file and error location; apply a bounded reviewed change, then rerun the approved typecheck.",
  },
  {
    code: "JS_FORMAT_OR_LINT",
    pattern: /prettier|eslint|oxlint|oxfmt|code style issues/i,
    gate: "lint",
    suggestion:
      "Inspect the formatter/linter diff and run the already-approved affected lint or format gate in a clean worktree.",
  },
  {
    code: "PHP_TEST",
    pattern: /phpunit|assertionfailed|failed asserting|tests: .*failed/i,
    gate: "test",
    suggestion:
      "Reproduce the exact failing PHPUnit test in an isolated worktree; use the assertion trace rather than changing unrelated production logic.",
  },
  {
    code: "AUTHORIZATION",
    pattern: /permission denied|unauthorized|403 forbidden/i,
    gate: "security",
    suggestion:
      "Inspect scoped CI permissions and credentials outside logs; do not publish or automatically widen secrets or roles.",
  },
  {
    code: "RATE_LIMIT",
    pattern: /\brate.limit\b|\b429\b|quota exceeded/i,
    gate: null,
    suggestion:
      "Respect the provider quota or Retry-After. Do not rotate keys, exceed free usage or retry in an unbounded loop.",
  },
];

export function safeCiStepName(value) {
  if (typeof value !== "string") return "REDACTED_STEP";
  if (
    value.length > 120 ||
    SECRET_INDICATOR.test(value) ||
    UNSAFE_URL.test(value) ||
    EMAIL.test(value)
  )
    return "REDACTED_STEP";
  return redact(value)
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 120);
}

export function triageCiFailure({
  lines = [],
  stepName = "",
  evidence = "UNKNOWN",
} = {}) {
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string"))
    throw new Error("INVALID_CI_DIAGNOSTICS");
  const safeLines = sanitizeCiLog(lines.join("\n")).lines;
  const cleanStep = safeCiStepName(stepName);
  const text = [cleanStep, ...safeLines].join(" ");
  const matched = RULES.find(({ pattern }) => pattern.test(text));
  const verifiedExcerpt =
    safeLines.length > 0 && evidence === "REDACTED_OUTPUT";
  const category = matched?.code ?? "UNCLASSIFIED";
  const key = createHash("sha256")
    .update(JSON.stringify([category, safeLines]))
    .digest("hex")
    .slice(0, 16);
  return {
    category,
    fingerprint: key,
    evidence: verifiedExcerpt ? "REDACTED_OUTPUT" : "INSUFFICIENT",
    rootCauseVerified: false,
    suggestedGateRole: verifiedExcerpt ? (matched?.gate ?? null) : null,
    nextAction: !verifiedExcerpt
      ? "RETRIEVE_EXACT_FAILED_STEP_DIAGNOSTICS"
      : (matched?.suggestion ??
        "Inspect the bounded error excerpt and reproduce with an existing authorized quality gate."),
    automaticFix: "DISABLED_UNTIL_ISOLATED_REVIEWED_PATCH_AND_GATES",
  };
}
